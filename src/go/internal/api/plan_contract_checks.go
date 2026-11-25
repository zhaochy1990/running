package api

import (
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const masterPlanSnapshotSchemaURL = "https://stride-running.cn/schemas/master-plan-snapshot.json"

// masterPlanSnapshotSchemaJSON is the JSON Schema of a newly generated season
// plan (the coach kernel's `MasterPlanSchema` output, before it is stored as
// content_version=2/3). Generated with the Weekly Plan schema by
// `pnpm run generate:weekly-plan-schema`; CI verifies the committed copy.
//
//go:embed master-plan-snapshot.schema.json
var masterPlanSnapshotSchemaJSON []byte

var appliedMasterPlanSnapshotSchema = mustCompilePlanSchema(masterPlanSnapshotSchemaURL, masterPlanSnapshotSchemaJSON, "Master Plan snapshot")

func mustCompilePlanSchema(url string, document []byte, name string) *jsonschema.Schema {
	var decoded any
	if err := json.Unmarshal(document, &decoded); err != nil {
		panic(fmt.Sprintf("decode embedded %s schema: %v", name, err))
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err := compiler.AddResource(url, decoded); err != nil {
		panic(fmt.Sprintf("load embedded %s schema: %v", name, err))
	}
	schema, err := compiler.Compile(url)
	if err != nil {
		panic(fmt.Sprintf("compile embedded %s schema: %v", name, err))
	}
	return schema
}

// ValidateMasterPlanSnapshot checks a generated season plan against the
// canonical structural contract (JSON Schema; the cross-field refinements
// stay with the TypeScript schema that produced it).
func ValidateMasterPlanSnapshot(document any) error {
	return appliedMasterPlanSnapshotSchema.Validate(document)
}

// ValidateWeeklyPlanContract checks a weekly plan against the full canonical
// contract — JSON Schema plus the superRefine rules — without storing it. It
// is the read-only counterpart of validateAppliedWeeklyPlan: same checks, the
// identity is taken from the document's own week_name.
func ValidateWeeklyPlanContract(document map[string]any) error {
	if document == nil {
		return fmt.Errorf("weekly plan content must be a JSON object")
	}
	_, err := validateAppliedWeeklyPlan(document, fmt.Sprint(document["week_name"]))
	return err
}
