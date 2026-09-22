package llm

import (
	"errors"
	"io"
	"testing"
)

// decodeJSON must stay strict for real contract violations, but tolerate the
// one provider artifact seen in production: a json_object response that stops
// one closing token short (finish_reason=stop, decode = unexpected EOF).
func TestDecodeJSON(t *testing.T) {
	type payload struct {
		Climate struct {
			Summary string `json:"summary"`
		} `json:"climate"`
		Windows []struct {
			Start string `json:"window_start"`
		} `json:"weather_windows"`
	}

	t.Run("valid document", func(t *testing.T) {
		var out payload
		err := decodeJSON(`{"climate":{"summary":"ok"},"weather_windows":[{"window_start":"03-01"}]}`, &out)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out.Climate.Summary != "ok" || len(out.Windows) != 1 {
			t.Fatalf("bad decode: %+v", out)
		}
	})

	t.Run("unknown field is rejected", func(t *testing.T) {
		var out payload
		err := decodeJSON(`{"climate":{"summary":"ok"},"nope":1}`, &out)
		if err == nil {
			t.Fatal("expected unknown-field error")
		}
	})

	t.Run("trailing json is rejected", func(t *testing.T) {
		var out map[string]any
		if err := decodeJSON(`{"a":1} {"b":2}`, &out); err == nil {
			t.Fatal("expected trailing-json error")
		}
	})

	t.Run("missing outermost closers is repaired", func(t *testing.T) {
		// The observed provider artifact: finish=stop but the final "}" (and
		// sometimes the array's "]" plus the string quote) never arrive.
		cases := []string{
			`{"climate":{"summary":"ok"},"weather_windows":[{"window_start":"03-01"},{"window_start":"03-08"}`,
			`{"climate":{"summary":"ok"},"weather_windows":[{"window_start":"03-01"}`,
			`{"climate":{"summary":"unterminated`,
		}
		for _, raw := range cases {
			var out payload
			if err := decodeJSON(raw, &out); err != nil {
				t.Errorf("repair failed for %q: %v", raw, err)
				continue
			}
			if out.Climate.Summary == "" {
				t.Errorf("empty summary for %q: %+v", raw, out)
			}
		}
	})

	t.Run("repair preserves structural characters inside strings", func(t *testing.T) {
		var out map[string]any
		// The brace inside the string must not be counted as a closer.
		raw := `{"a":{"b":"c}"` // unterminated string holding a brace
		if err := decodeJSON(raw, &out); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out["a"].(map[string]any)["b"] != "c}" {
			t.Fatalf("bad repair: %+v", out)
		}
	})

	t.Run("garbage still fails loudly", func(t *testing.T) {
		var out map[string]any
		err := decodeJSON(`not json at all`, &out)
		if err == nil || errors.Is(err, io.EOF) {
			t.Fatalf("expected a loud failure, got: %v", err)
		}
	})
}

// closeOpenStructures never invents content: a complete document is returned
// unchanged (the stack is empty), so the repair path cannot corrupt output.
func TestCloseOpenStructuresCompleteDocumentUnchanged(t *testing.T) {
	raw := `{"a":[1,2,{"b":"}["}]}`
	if got := closeOpenStructures(raw); got != raw {
		t.Fatalf("complete document changed: %q", got)
	}
}
