# Native preparation lifetime — working increment

The actual RestitchPrepareBridge previously treated an abort request as completed
work. Its canceled state immediately made busy() false, permitted same-ID reuse,
and allowed history eviction while transport/probe/cleanup still ran. shutdown()
aborted controllers and cleared the registry without joining those operations.
A throwing progress sink could also strand a run before any work started.

Five deferred real-bridge regressions reproduce all five failures. The bridge
now owns its completion promise before it publishes or starts I/O. Active work is
independent of the requested UI state. Cancellation remains running in its report
until the original work and cleanup have settled; same-ID reuse and eviction stay
fenced until then. Shutdown closes admission and awaits the original completions.
The progress sink cannot interrupt preparation. Existing managed-tool, signal and
cleanup seams remain responsible for actual child termination; no timeout or abort
flag is substituted for observed completion.

The five causal regressions and the retained-findings scenario pass together with
the actual SQL cleanup-coverage case (7selected checks). A previous timing-based
retained-findings fixture assumed40ms could not reach a third inspection. It now
cancels deterministically during the second probe, retains both completed findings
and proves no third probe starts. The later broad314-test matrix is not acceptance:
its5001-folder fixture and worker transport time out under host memory pressure.
Full current-source checks and installed/manual acceptance remain pending.

Progress still uses the existing content-free operationId/state/stage seam. No
provider payload, file path or name is added to it. This change does not create a
server executor quiescence receipt, resolve unknown range accounting, wire the
fallback controller or close T019. Complete preparation diagnostic delivery through
journal ingestion and SELECT-only investigation remains part of T018/T019.

A subsequent controller-next increment reproduces the same lifetime gap in the
ordinary download bridge. Its old finally block removed the active operation
before awaiting source cleanup, and shutdown only requested abort. Three bounded
actual-source assertions fail on the old code: busy through cleanup, shutdown
joining cleanup and closed admission after shutdown. All three pass after the
bridge owns a completion before calling the destination picker/transfer, keeps
the active ID through cleanup and joins those original completions on shutdown.
The synchronous picker start remains compatible with the existing route contract.
The incoming operation/grant primitives are captured before any destination wait.

Three Vitest regressions are written; full execution remains pending while the
frozen recovery-next verification runs. This local lifetime fix is not an owned
executor quiescence receipt and does not authorize replacing or retiring a root.

### Managed child lifetime increment (source only)

A live child emitting an error does not prove process exit. The stitcher now
joins close, retains the first tool error, installs ownership listeners before
external observers and contains progress-observer exceptions. Its default
termination deadline scales with the active power limit; explicit scaled
deadlines and full-power timing retain their prior behavior.

The shared spawn seam also keeps governor registration and termination
escalation until close when a PID exists. It records an exit only after close
or a proven failure to spawn. Three causal shared-seam regressions fail before
the fix; four shared-seam cases and seven stitcher cases pass afterwards. The
combined run with real diagnostic-journal and power-timeout regressions passes
65 tests in four files. This is not an installed native ownership controller,
a server retirement receipt or manual beta acceptance.
