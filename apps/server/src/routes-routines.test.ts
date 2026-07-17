import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { closeDb, openDb } from "./db/index.ts"
import { createRoutine, finishRun, startRun } from "./db/routines.ts"
import { RoutinesRunner } from "./routines-runner.ts"
import { buildRoutinesRouter } from "./routes-routines.ts"

let dbDir: string | undefined

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-routes-routines-"))
	openDb({ path: path.join(dbDir, "deck.db") })
}

afterEach(() => {
	closeDb()
	if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true })
	dbDir = undefined
})

describe("routine history limit", () => {
	test("uses a default of 20 and only accepts finite integer limits from 1 through 500", async () => {
		bootDb()
		const routine = createRoutine({
			name: "history fixture",
			cron: "* * * * *",
			actionKind: "script",
			actionBody: "",
		})
		for (let index = 0; index < 21; index += 1) {
			const run = startRun(routine.id, "manual")
			finishRun(run.id, { exitCode: 0 })
		}
		const runner = new RoutinesRunner()
		const app = buildRoutinesRouter(runner)

		try {
			const defaultResponse = await app.request(`/routines/${routine.id}/runs`)
			expect(defaultResponse.status).toBe(200)
			expect((await defaultResponse.json() as { runs: unknown[] }).runs).toHaveLength(20)

			const maxResponse = await app.request(`/routines/${routine.id}/runs?limit=500`)
			expect(maxResponse.status).toBe(200)
			expect((await maxResponse.json() as { runs: unknown[] }).runs).toHaveLength(21)

			for (const limit of ["0", "1.5", "501", "Infinity", "NaN"]) {
				const response = await app.request(`/routines/${routine.id}/runs?limit=${limit}`)
				expect(response.status).toBe(400)
			}
		} finally {
			runner.dispose()
		}
	})
})
