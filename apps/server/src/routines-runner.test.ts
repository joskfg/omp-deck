import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { RoutineSpec } from "@omp-deck/protocol"

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts"
import { closeDb, openDb } from "./db/index.ts"
import { createV1Routine, getRun, startRun } from "./db/routines.ts"
import { ConcurrencyController } from "./routines/concurrency.ts"
import { runV1Pipeline } from "./routines/v1-runner.ts"
import { RoutinesRunner } from "./routines-runner.ts"

let dbDir: string | undefined

function bootDb(): string {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routines-runner-"))
	openDb({ path: path.join(dbDir, "deck.db") })
	return dbDir
}

function createQueuedWaitRoutine(): ReturnType<typeof createV1Routine> {
	const spec: RoutineSpec = {
		name: "queued wait",
		trigger: [],
		concurrency: "queue",
		steps: [{ id: "wait", type: "wait", duration_secs: 0.05 }],
	}
	return createV1Routine({
		name: spec.name,
		specYaml: JSON.stringify(spec),
		spec,
	})
}

afterEach(() => {
	closeDb()
	if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true })
	dbDir = undefined
})

describe("ConcurrencyController queued runs", () => {
	test("does not promote queued work cancelled before its slot is released", async () => {
		const controller = new ConcurrencyController()
		const active = controller.decide("routine", "active", "queue")
		const queued = controller.decide("routine", "queued", "queue")
		expect(active.kind).toBe("go")
		expect(queued.kind).toBe("queue")
		if (queued.kind !== "queue") return

		queued.abort.abort()
		await queued.release
		expect(controller.snapshot()).toEqual([{ routineId: "routine", active: 1, queued: 0 }])

		controller.finish("routine", "queued")
		expect(controller.snapshot()).toEqual([{ routineId: "routine", active: 1, queued: 0 }])
		controller.finish("routine", "active")
		expect(controller.snapshot()).toEqual([])
	})
})

describe("RoutinesRunner V1 execution", () => {
	test("waits for a queued run's slot before starting its pipeline", async () => {
		bootDb()
		const routine = createQueuedWaitRoutine()
		const runner = new RoutinesRunner()
		const frames: BroadcastFrame[] = []
		let resolveFirstStarted: (() => void) | undefined
		const firstStarted = new Promise<void>((resolve) => {
			resolveFirstStarted = resolve
		})
		const unsubscribe = broadcastBus.subscribe((frame) => {
			frames.push(frame)
			if (frame.type === "routine_run_started") resolveFirstStarted?.()
		})

		try {
			const first = runner.fire(routine.id)
			await firstStarted
			const second = runner.fire(routine.id)
			await Promise.resolve()

			expect(frames.filter((frame) => frame.type === "routine_run_started")).toHaveLength(1)

			await first
			await second
			const eventTypes = frames.map((frame) => frame.type)
			const firstFinished = eventTypes.indexOf("routine_run_finished")
			const secondStarted = eventTypes.lastIndexOf("routine_run_started")
			expect(firstFinished).toBeGreaterThanOrEqual(0)
			expect(secondStarted).toBeGreaterThan(firstFinished)
		} finally {
			unsubscribe()
			runner.dispose()
		}
	})

	test("finalizes a run as failed when an executor throws", async () => {
		const tempDir = bootDb()
		const spec: RoutineSpec = {
			name: "broken command render",
			trigger: [],
			steps: [{ id: "run", type: "run", command: "{{ run.id | nope }}" }],
		}
		const routine = createV1Routine({
			name: spec.name,
			specYaml: JSON.stringify(spec),
			spec,
		})
		const run = startRun(routine.id, "manual")

		const result = await runV1Pipeline({
			routine,
			spec,
			runId: run.id,
			triggerKind: "manual",
			triggerPayload: {},
			abortSignal: new AbortController().signal,
			defaultCwd: tempDir,
			agentSandboxRoot: tempDir,
		})

		expect(result).toEqual({ status: "failed", abortReason: "failure" })
		const persisted = getRun(run.id)
		expect(persisted?.endedAt).toBeDefined()
		expect(persisted?.abortReason).toBe("failure")
		expect(persisted?.error).toBe("aborted: failure")
	})
})
