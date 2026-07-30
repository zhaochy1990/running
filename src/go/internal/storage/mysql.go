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

// AutoMigrate creates/updates the jobs and pipeline_runs tables.
func (s *Store) AutoMigrate(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&jobModel{}, &pipelineRunModel{}); err != nil {
		return fmt.Errorf("storage: automigrate: %w", err)
	}
	return nil
}

// Jobs returns the job.Store implementation.
func (s *Store) Jobs() job.Store { return &jobStore{db: s.db} }

// Pipelines returns the job.PipelineStore implementation.
func (s *Store) Pipelines() job.PipelineStore { return &pipelineStore{db: s.db} }

// JobByIdempotencyKey returns the job with the given idempotency key in the
// partition, or a job.ErrNotFound. Used by the HTTP API to resolve a duplicate
// create (same key) back to the existing job.
func (s *Store) JobByIdempotencyKey(ctx context.Context, partitionKey, key string) (*job.Job, error) {
	return (&jobStore{db: s.db}).byIdempotencyKey(ctx, partitionKey, key)
}

// PipelineRunByIdempotencyKey returns the run with the given idempotency key in
// the partition, or a job.ErrNotFound.
func (s *Store) PipelineRunByIdempotencyKey(ctx context.Context, partitionKey, key string) (*job.PipelineRun, error) {
	return (&pipelineStore{db: s.db}).byIdempotencyKey(ctx, partitionKey, key)
}

// PipelineRunsByUser returns the pipeline runs triggered by userID, most recent
// first (capped at maxPipelineRunsPerUser). Used by GET /api/users/{uid}/pipelines.
func (s *Store) PipelineRunsByUser(ctx context.Context, userID string) ([]*job.PipelineRun, error) {
	return (&pipelineStore{db: s.db}).listByUser(ctx, userID)
}

// isDuplicateKey reports whether err is a MySQL duplicate-entry (1062) error,
// which fires when the unique (partition_key, idempotency_key) index is violated.
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

func (s *jobStore) Get(ctx context.Context, partitionKey, jobID string) (*job.Job, error) {
	var m jobModel
	err := s.db.WithContext(ctx).
		Where("partition_key = ? AND id = ?", partitionKey, jobID).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: partitionKey + "|" + jobID}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain(), nil
}

// byIdempotencyKey looks up a job by (partition_key, idempotency_key).
func (s *jobStore) byIdempotencyKey(ctx context.Context, partitionKey, key string) (*job.Job, error) {
	var m jobModel
	err := s.db.WithContext(ctx).
		Where("partition_key = ? AND idempotency_key = ?", partitionKey, key).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: partitionKey + "|idem|" + key}
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

func (s *pipelineStore) Get(ctx context.Context, partitionKey, runID string) (*job.PipelineRun, error) {
	var m pipelineRunModel
	err := s.db.WithContext(ctx).
		Where("partition_key = ? AND run_id = ?", partitionKey, runID).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: partitionKey + "|" + runID}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain()
}

// byIdempotencyKey looks up a pipeline run by (partition_key, idempotency_key).
func (s *pipelineStore) byIdempotencyKey(ctx context.Context, partitionKey, key string) (*job.PipelineRun, error) {
	var m pipelineRunModel
	err := s.db.WithContext(ctx).
		Where("partition_key = ? AND idempotency_key = ?", partitionKey, key).
		First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &job.ErrNotFound{Key: partitionKey + "|idem|" + key}
	}
	if err != nil {
		return nil, err
	}
	return m.toDomain()
}

// maxPipelineRunsPerUser caps a per-user listing so a user with a long history
// cannot force an unbounded result set (the endpoint is on a public ingress).
const maxPipelineRunsPerUser = 200

// listByUser returns the runs triggered by userID, newest first, capped at
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
