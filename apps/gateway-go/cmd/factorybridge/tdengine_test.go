package main

import "testing"

func TestTDenginePassword(t *testing.T) {
	t.Run("url empty", func(t *testing.T) {
		t.Setenv("TDENGINE_URL", "")
		t.Setenv("TDENGINE_PASSWORD", "")
		got, err := tdenginePassword()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "" {
			t.Fatalf("password = %q, want empty", got)
		}
	})

	t.Run("url set and password set", func(t *testing.T) {
		t.Setenv("TDENGINE_URL", "http://tdengine:6041")
		t.Setenv("TDENGINE_PASSWORD", "s3cret")
		got, err := tdenginePassword()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "s3cret" {
			t.Fatalf("password = %q, want s3cret", got)
		}
	})

	t.Run("url set and password empty", func(t *testing.T) {
		t.Setenv("TDENGINE_URL", "http://tdengine:6041")
		t.Setenv("TDENGINE_PASSWORD", "")
		if _, err := tdenginePassword(); err == nil {
			t.Fatal("expected error when TDENGINE_URL is set and TDENGINE_PASSWORD is empty")
		}
	})
}
