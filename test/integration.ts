/**
 * Adapter integration test using the @iobroker/testing harness.
 *
 * Spins up a real (but in-memory) ioBroker controller, starts the adapter,
 * waits 10 seconds and asserts that no fatal error or unhandled exception
 * occurred. Required by the official ioBroker repo checker.
 *
 * Note: We don't have a real BK215 in CI, so we expect the adapter to
 * complete `onReady` and either log "no host configured" or sit in the
 * reconnect loop. Either is fine — we only fail on hard crashes.
 *
 * Shutdown: the second test stops the adapter and requires its process to end
 * within a time limit. A harness can only start the adapter once, and the
 * adapter runs in its own process here, so this does not cover compact mode.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { tests } from "@iobroker/testing";

const STOP_LIMIT_MS = 10_000;

tests.integration(path.join(__dirname, ".."), {
  // Exit code 11 = ioBroker convention for "missing config, do not restart".
  // Our adapter terminates with 11 when no host is configured AND mDNS
  // discovers nothing — which is the expected state in CI.
  allowedExitCodes: [0, 11],
  defineAdditionalTests({ suite }) {
    suite("runs without crashing", (getHarness) => {
      it("survives 10 seconds without error", async function () {
        this.timeout(60_000);
        const harness = getHarness();
        await harness.startAdapterAndWait();
        await new Promise((r) => setTimeout(r, 10_000));
      });
    });

    suite("Shutdown", (getHarness) => {
      it("stops cleanly within the time limit", async function () {
        this.timeout(60_000);
        const harness = getHarness();

        await harness.startAdapterAndWait();
        await new Promise((r) => setTimeout(r, 5_000));
        assert.equal(
          harness.isAdapterRunning(),
          true,
          "the adapter ended before it was stopped",
        );

        await Promise.race([
          harness.stopAdapter(),
          new Promise((r) => setTimeout(r, STOP_LIMIT_MS)),
        ]);
        assert.equal(
          harness.isAdapterRunning(),
          false,
          `the adapter still runs after ${STOP_LIMIT_MS} ms`,
        );
      });
    });
  },
});
