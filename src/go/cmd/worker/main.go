// Command worker runs the async-job worker: it consumes pointer messages from
// RabbitMQ and dispatches them to registered handlers, persisting state in MySQL.
//
// This main is intentionally thin — it only parses config, wires dependencies,
// and runs. All logic lives in internal/. The store/broker/consumer wiring is
// still pending (see the async-job worker ADRs under docs/adr/).
package main

import (
	"log/slog"
	"os"

	"github.com/zhaochy1990/stride/internal/job"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)

	// Handlers register here; the registry is read-only once running.
	reg := job.NewRegistry()

	// TODO(worker): load config (internal/config), build the MySQL store
	// (internal/storage) and RabbitMQ publisher+consumer (internal/mq), then:
	//   d := job.NewDispatcher(store, reg, publisher, orchestrator, policy)
	//   consumer.Run(ctx, d.Dispatch)
	log.Info("worker starting", "registered_types", reg.Types())
}
