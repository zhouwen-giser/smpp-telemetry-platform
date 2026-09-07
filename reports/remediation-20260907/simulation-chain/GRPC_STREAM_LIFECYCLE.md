# Adapter gRPC stream lifecycle remediation

The business-event stream and execution-event stream registered their initial no-op unsubscribe callback before asynchronous replay/lookup completed. Disconnecting did not remove the subsequently registered event listener, and cancellation during replay could install a listener after the stream was already closed.

Both streams now use a single close state, release the current listener exactly once on cancelled/close/error, and check the close state after asynchronous reads and before subsequent writes/subscription. Late replay/lookup failures after cancellation are ignored; open execution lookup failures are delivered through the stream. This change does not add stream write backpressure.

Validation:
- 13 lifecycle regression cases passed, covering repeated durable/live reconnects, all three terminal events, replay cancellation before resolve/reject, close during replay writes, cursor errors, execution listener cleanup, cancelled lookup resolve/reject, and open lookup failure.
- Existing UGV and NPC gRPC E2E tests passed alongside these cases: 16/16 total across 3 files, using actual isolated localhost gRPC servers.
- Full sibling TypeScript check passed with zero diagnostics.

Only packages/provider-adapter-kit/src/vehicle-grpc-server.ts and tests/unit/vehicle-grpc-stream-lifecycle.test.ts were changed. The source file was clean before this fix. The exact runtime module and hashes are in grpc-stream-artifact.json. Compilation used TypeScript transpileModule on only this module after the full project typecheck; unrelated dist modules were not rebuilt.
