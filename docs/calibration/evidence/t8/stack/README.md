# T8 captured-data stack engineering validation

This directory records engineering evidence only. It does not score final holdout
outcomes, establish physiological thresholds or authorise candidate activation.
The candidate remains `release_ready=false` and production active remains v3.

The opt-in entry point is
`src/go/internal/handlers/compute/calibration_stack_mysql_test.go`,
`TestCalibrationCapturedStack`. Its default skip is not test evidence.

The test requires the exclusive local policy writer window and refuses all but
root/TCP `127.0.0.1:13383/stride_983_test` before any migration. The broker must be
an owned RabbitMQ at `127.0.0.1:13384`; never reuse the existing local stack's
5672 broker. Start an owned disposable Rabbit container and delete it after the
Go test exits normally. Leave the parent-owned MySQL container intact.

Only the two explicitly allowlisted private NONFINAL gzip manifests are opened;
final/holdout splits and all other paths are refused. The input cutoff must be
the current Shanghai day because the real job/API clocks are not replaced. A
later-day rerun needs a freshly authorised NONFINAL capture, rather than shifting
real event dates. Input identities are replaced with one random UUID and stable
local activity ordinals. Measured samples/laps are checked exactly after the
real sync persistence, codec, object-store and provider roundtrip. UTC activity
timestamps use Shanghai noon for the manifest's civil day, whose original
intra-day instant is absent from this domain manifest. This is a captured sync
persistence replay, not a new vendor network sync.

## Running

Use Node 24 and install/build the workspace in this checkout:

```sh
pnpm install --offline --frozen-lockfile
pnpm -r --workspace-concurrency=1 build
swift test --package-path ios-app/StrideKit --filter CalibrationCapturedStackTests
```

The last command builds the Swift reader; without the explicit environment it
skips, and does not count as a live pass. Start the Go coordinator, with a private
0600 log, in `src/go` using the dedicated DSN and owned local AMQP URL:

```sh
STRIDE_991_NONFINAL_MANIFEST=/tmp/stride-983/private/t3-reviewed-input-manifest.json.gz \
STRIDE_991_STACK_OUTPUT=/tmp/stride-983/private/t8-stack.json \
STRIDE_WORKER_TEST_MYSQL_DSN="$ISOLATED_MYSQL_DSN" \
STRIDE_991_AMQP_URL="$OWN_LOCAL_AMQP_URL" GIN_MODE=release \
go test ./internal/handlers/compute -run '^TestCalibrationCapturedStack$' -count=1 -v -timeout 50m
```

It imports captured data through Go storage APIs, then runs real RabbitMQ
publisher confirms/consumer acknowledgements, durable MySQL jobs, dispatcher
and pipeline orchestration. The captured importer is a test-only handler; the
calibration, compute and ability handlers are production implementations.
First compute proves missing history causes zero derived writes. Explicit
historical v3/v4 snapshots are produced by the canonical offline engine and
storage publisher, then full load/classification/zones/zero-anchor PMC and
ability/L1 run in that order. No additional baseline algorithm is implemented.

The coordinator writes a private control file for each of `active3`, `active4`,
`rollback3` and waits. For each phase, read the phase name, run these read-only
companions from the repository root, and only after both succeed create
`$STRIDE_991_STACK_OUTPUT.<phase>.continue`:

```sh
STRIDE_991_STACK_OUTPUT=/tmp/stride-983/private/t8-stack.json \
STRIDE_991_MYSQL_URL="$ISOLATED_MYSQL_URL" \
node --import ./src/wechat-miniprogram/utils/ts-resolve-hooks.mjs scripts/calibration-stack-read.mjs

STRIDE_991_STACK_OUTPUT=/tmp/stride-983/private/t8-stack.json \
swift test --package-path ios-app/StrideKit --skip-build --filter CalibrationCapturedStackTests
```

The Node companion reads through the real `MySqlDataProvider`, invokes the
actual Coach `get_running_calibration` tool, verifies signed HTTP response
identity and runs existing Web and MP projectors. Swift uses the real APIClient,
wire decoder and display projector on the same response hash. It exercises a
host Swift reader, not a new simulator/UI run; T7's reviewed UI evidence is
inherited separately. There is no HTTP interception or fabricated API response.

The captured preview in this harness requests activity loads only; its ability
source argument is absent, so `ability:null` means not requested. Active-v3
ability/L1 persistence and the active4 ability write guard are exercised by the
real handlers. Candidate ability preview accuracy is not evaluated.

The coordinator checks no future/mixed-version lineage, exact five-table row
identity around preview and reads, nil candidate centers without v3 merging,
active4 compute/ability write guards, policy rollback and explicit full v3
recompute. Changing the policy pointer alone is not described as a derived-data
rollback. Candidate-derived active persistence is deliberately unsupported by
ADR0045 and is not claimed as validated. It does not rewrite existing plans.

Normal completion shuts down the Gin listener and Rabbit consumer, deletes the
random identity through storage ownership (including all five derived tables),
and restores policy values 3/4/3. Private `*.summary.json`, `*.preview.json`,
phase receipts and logs contain the detailed captured-data results. Public
receipts include only aggregates and hashes. The 20% load-change count is an
engineering inventory threshold, not a frozen accuracy or release gate.

Normal production binary/COS configuration, external watch authentication/network
sync, full deployment topology and new device UI traversal are not covered.
Zero production writes, no new registered account, no formal plan generation,
no model/parameter/protocol change and no final-holdout access are required.
