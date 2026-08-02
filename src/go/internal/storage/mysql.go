package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	gomysql "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/zhaochy1990/stride/internal/job"
)

// Store owns the GORM handle and exposes the job/pipeline stores.
type Store struct {
	db *gorm.DB
}

// Open connects to MySQL, forcing the DSN to parseTime=true & loc=UTC so
// timestamps never undergo an implicit timezone conversion (ADR 0003).
func Open(dsn string) (*Store, error) {
	normalized, err := forceUTCDSN(dsn)
	if err != nil {
		return nil, err
	}
	db, err := gorm.Open(mysql.Open(normalized), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
		NowFunc: func() time.Time {
			return time.Now().UTC()
		},
	})
	if err != nil {
		return nil, fmt.Errorf("storage: open mysql: %w", err)
	}
	return &Store{db: db}, nil
}

// forceUTCDSN parses a go-sql-driver DSN and forces parseTime + UTC location and
// session time zone. It returns an error if the DSN is unparseable.
func forceUTCDSN(dsn string) (string, error) {
	cfg, err := gomysql.ParseDSN(dsn)
	if err != nil {
		return "", fmt.Errorf("storage: parse dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = map[string]string{}
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN(), nil
}

// AutoMigrate creates/updates the jobs and pipeline_runs tables. It first
// applies a transitional rename of the legacy partition_key/user_id columns to
// the new user_id (subject) / created_by (actor) shape, so an existing database
// upgrades in place; on a fresh database the renames are skipped and the tables
// are created directly in the new shape.
func (s *Store) AutoMigrate(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	if err := s.migrateLegacyPartitionColumns(db); err != nil {
		return err
	}
	if err := db.AutoMigrate(&jobModel{}, &pipelineRunModel{}); err != nil {
		return fmt.Errorf("storage: automigrate: %w", err)
	}
	return nil
}

// migrateLegacyPartitionColumns renames pre-rename columns/indexes to the new
// shape. Each step is guarded by a HasColumn/HasIndex check so it is idempotent
// and a no-op on a fresh database. AutoMigrate then reconciles types, nullability
// and rebuilds the new indexes.
func (s *Store) migrateLegacyPartitionColumns(db *gorm.DB) error {
	m := db.Migrator()

	if m.HasTable(&jobModel{}) {
		if m.HasColumn(&jobModel{}, "partition_key") && !m.HasColumn(&jobModel{}, "user_id") {
			if err := m.RenameColumn(&jobModel{}, "partition_key", "user_id"); err != nil {
				return fmt.Errorf("storage: rename jobs.partition_key: %w", err)
			}
		}
		for _, idx := range []string{"idx_jobs_partition", "uq_jobs_partition_idem"} {
			if m.HasIndex(&jobModel{}, idx) {
				if err := m.DropIndex(&jobModel{}, idx); err != nil {
					return fmt.Errorf("storage: drop jobs index %s: %w", idx, err)
				}
			}
		}
	}

	if m.HasTable(&pipelineRunModel{}) {
		// Order matters: the legacy user_id (triggerer) becomes created_by first,
		// then partition_key (subject) takes over the user_id column name.
		if m.HasColumn(&pipelineRunModel{}, "user_id") && !m.HasColumn(&pipelineRunModel{}, "created_by") {
			if err := m.RenameColumn(&pipelineRunModel{}, "user_id", "created_by"); err != nil {
				return fmt.Errorf("storage: rename pipeline_runs.user_id: %w", err)
			}
		}
		if m.HasColumn(&pipelineRunModel{}, "partition_key") {
			if err := m.RenameColumn(&pipelineRunModel{}, "partition_key", "user_id"); err != nil {
				return fmt.Errorf("storage: rename pipeline_runs.partition_key: %w", err)
			}
		}
		for _, idx := range []string{"idx_runs_partition", "uq_runs_partition_idem", "idx_runs_user"} {
			if m.HasIndex(&pipelineRunModel{}, idx) {
				if err := m.DropIndex(&pipelineRunModel{}, idx); err != nil {
					return fmt.Errorf("storage: drop pipeline_runs index %s: %w", idx, err)
				}
			}
		}
	}
	return nil
}

// Jobs returns the job.Store implementation.
func (s *Store) Jobs() job.Store { return &jobStore{db: s.db} }

// Pipelines returns the job.PipelineStore implementation.
func (s *Store) Pipelines() job.PipelineStore { return &pipelineStore{db: s.db} }

// JobByIdempotencyKey returns the job with the given idempotency key for the
// user, or a job.ErrNotFound. Used by the HTTP API to resolve a duplicate
// create (same key) back to the existing job.
func (s *Store) JobByIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error) {
	return (&jobStore{db: s.db}).byIdempotencyKey(ctx, userID, key)
}

// PipelineRunByIdempotencyKey returns the run with the given idempotency key for
// the user, or a job.ErrNotFound.
func (s *Store) PipelineRunByIdempotencyKey(ctx context.Context, userID, key string) (*job.PipelineRun, error) {
	return (&pipelineStore{db: s.db}).byIdempotencyKey(ctx, userID, key)
}

// PipelineRunsByUser returns the pipeline runs for userID (the subject), most
// recent first (capped at maxPipelineRunsPerUser). Used by GET
// /api/users/{uid}/pipelines.
func (s *Store) PipelineRunsByUser(ctx context.Context, userID string) ([]*job.PipelineRun, error) {
	return (&pipelineStore{db: s.db}).listByUser(ctx, userID)
}

// isDuplicateKey reports whether err is a MySQL duplicate-entry (1062) error,
// which fires when the unique (user_id, idempotency_key) index is violated.
func isDuplicateKey(err error) bool {
	var me *gomysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}

// Ping verifies connectivity (used by the health check).
func (s *Store) Ping(ctx context.Context) error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.PingContext(ctx)
}

// Close releases the underlying connection pool.
func (s *Store) Close() error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// --- job.Store -----------------------------------------------------------

type jobStore struct{ db *gorm.DB }

func (s *jobStore) Create(ctx context.Context, j *job.Job) error {
	err := s.db.WithContext(ctx).Create(toJobModel(j)).Error
	if isDuplicateKey(err) {
		return job.ErrConflict
	}
	return err
}

func (s *jobStore) Get(ctx context.Context, jobID string) (*job.Job, error) {
	var m jobModel
	err := s.db.WithContext(ctx).
		Where("id = ?", jobID).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: jobID}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain(), nil
}

// byIdempotencyKey looks up a job by (user_id, idempotency_key).
func (s *jobStore) byIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error) {
	var m jobModel
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND idempotency_key = ?", userID, key).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: userID + "|idem|" + key}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain(), nil
}

func (s *jobStore) Update(ctx context.Context, j *job.Job) error {
	// Save writes all columns for the row identified by the primary key (id).
	return s.db.WithContext(ctx).Save(toJobModel(j)).Error
}

// --- job.PipelineStore ---------------------------------------------------

type pipelineStore struct{ db *gorm.DB }

func (s *pipelineStore) Create(ctx context.Context, r *job.PipelineRun) error {
	m, err := toPipelineModel(r)
	if err != nil {
		return err
	}
	err = s.db.WithContext(ctx).Create(m).Error
	if isDuplicateKey(err) {
		return job.ErrConflict
	}
	return err
}

func (s *pipelineStore) Get(ctx context.Context, runID string) (*job.PipelineRun, error) {
	var m pipelineRunModel
	err := s.db.WithContext(ctx).
		Where("run_id = ?", runID).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: runID}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain()
}

// byIdempotencyKey looks up a pipeline run by (user_id, idempotency_key).
func (s *pipelineStore) byIdempotencyKey(ctx context.Context, userID, key string) (*job.PipelineRun, error) {
	var m pipelineRunModel
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND idempotency_key = ?", userID, key).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: userID + "|idem|" + key}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain()
}

// maxPipelineRunsPerUser caps a per-user listing so a user with a long history
// cannot force an unbounded result set (the endpoint is on a public ingress).
const maxPipelineRunsPerUser = 200

// listByUser returns the runs for userID (the subject), newest first, capped at
// maxPipelineRunsPerUser. An empty userID returns no rows (never a full scan).
func (s *pipelineStore) listByUser(ctx context.Context, userID string) ([]*job.PipelineRun, error) {
	if userID == "" {
		return []*job.PipelineRun{}, nil
	}
	var models []pipelineRunModel
	err := s.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Limit(maxPipelineRunsPerUser).
		Find(&models).Error
	if err != nil {
		return nil, err
	}
	runs := make([]*job.PipelineRun, 0, len(models))
	for i := range models {
		r, err := models[i].toDomain()
		if err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, nil
}

func (s *pipelineStore) Update(ctx context.Context, r *job.PipelineRun) error {
	m, err := toPipelineModel(r)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).Save(m).Error
}
