// Subcommand group `stride watch workout`: push / manage workouts on the watch
// schedule. Go port of the Python `coros-sync workout` CLI — same verbs (push
// easy|tempo|interval|long, delete, schedule) driving the same provider
// adapter path the server uses.
package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/zhaochy1990/stride/internal/provider"
)

func newWatchWorkoutCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "workout",
		Short: "Push / manage workouts on the watch schedule",
		Long: "Workout scheduling on the bound watch provider (COROS / Garmin).\n\n" +
			"push uploads a running workout to the training schedule; delete removes\n" +
			"previously-pushed [STRIDE] entries on a date (COROS); schedule lists what\n" +
			"is on the watch for a date range (COROS).",
	}
	c.AddCommand(
		newWatchWorkoutPushCmd(),
		newWatchWorkoutDeleteCmd(),
		newWatchWorkoutScheduleCmd(),
	)
	return c
}

func newWatchWorkoutPushCmd() *cobra.Command {
	var (
		profile, date, paceLow, paceHigh, namePrefix string
		mpPaceLow, mpPaceHigh                        string
		distance, duration, mpKm, recoveryMin        float64
		reps, intervalM                              int
	)
	c := &cobra.Command{
		Use:   "push <easy|tempo|interval|long>",
		Short: "Push a running workout to the watch training schedule",
		Long: "Push a running workout to the training schedule.\n\n" +
			"Examples:\n" +
			"  stride watch workout push easy --date 20260401 --distance 10 --pace-low 5:40 --pace-high 5:20\n" +
			"  stride watch workout push tempo --date 20260402 --distance 8 --pace-low 3:55 --pace-high 3:50\n" +
			"  stride watch workout push interval --date 20260403 --reps 5 --interval-m 1000 --pace-low 3:40 --pace-high 3:35\n" +
			"  stride watch workout push long --date 20260405 --distance 30 --mp-km 10 --pace-low 5:20 --pace-high 5:00",
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return runWorkoutPush(profile, args[0], date, distance, duration, paceLow, paceHigh,
				reps, intervalM, recoveryMin, mpKm, mpPaceLow, mpPaceHigh, namePrefix)
		},
	}
	f := c.Flags()
	f.StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	f.StringVar(&date, "date", "", "workout date YYYYMMDD")
	f.Float64Var(&distance, "distance", 0, "distance in km (training segment)")
	f.Float64Var(&duration, "duration", 0, "duration in minutes (training segment)")
	f.StringVar(&paceLow, "pace-low", "", "slower pace target (e.g. 5:40)")
	f.StringVar(&paceHigh, "pace-high", "", "faster pace target (e.g. 5:20)")
	f.IntVar(&reps, "reps", 0, "number of intervals (interval type)")
	f.IntVar(&intervalM, "interval-m", 0, "interval distance in meters (interval type)")
	f.Float64Var(&recoveryMin, "recovery-min", 3, "recovery jog between intervals (min)")
	f.Float64Var(&mpKm, "mp-km", 0, "marathon pace km at end (long run)")
	f.StringVar(&mpPaceLow, "mp-pace-low", "4:10", "marathon pace low (long run)")
	f.StringVar(&mpPaceHigh, "mp-pace-high", "4:00", "marathon pace high (long run)")
	f.StringVar(&namePrefix, "name-prefix", "", "prefix for workout name (e.g. [STRIDE])")
	return c
}

func runWorkoutPush(profile, workoutType, date string, distance, duration float64, paceLow, paceHigh string, reps, intervalM int, recoveryMin, mpKm float64, mpPaceLow, mpPaceHigh, namePrefix string) error {
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	isoDate, err := yyyymmddToISO(date)
	if err != nil {
		return err
	}

	var w provider.RunWorkout
	switch workoutType {
	case "easy":
		d := orDefault(distance, 10)
		w = easyRunWorkout(isoDate, d, orDefaultStr(paceLow, "5:40"), orDefaultStr(paceHigh, "5:20"))
	case "tempo":
		w = tempoRunWorkout(isoDate, orDefault(distance, 8), orDefaultStr(paceLow, "3:55"), orDefaultStr(paceHigh, "3:50"))
	case "interval":
		if reps == 0 || intervalM == 0 {
			return fmt.Errorf("--reps and --interval-m are required for interval workouts")
		}
		w = intervalRunWorkout(isoDate, reps, intervalM, orDefaultStr(paceLow, "3:40"), orDefaultStr(paceHigh, "3:35"), recoveryMin)
	case "long":
		total := orDefault(distance, 30)
		w = longRunWorkout(isoDate, total, total-mpKm, mpKm,
			orDefaultStr(paceLow, "5:20"), orDefaultStr(paceHigh, "5:00"),
			mpPaceLow, mpPaceHigh)
	default:
		return fmt.Errorf("unknown workout type %q (want easy|tempo|interval|long)", workoutType)
	}
	if namePrefix != "" {
		w.Name = namePrefix + " " + w.Name
	}

	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()
	prov, name, err := resolveProvider(store, cfg, user)
	if err != nil {
		return err
	}
	id, err := prov.PushRunWorkout(context.Background(), user, w)
	if err != nil {
		return err
	}
	fmt.Printf("pushed %q to %s (provider=%s idInPlan=%s)\n", w.Name, date, name, id)
	return nil
}

func newWatchWorkoutDeleteCmd() *cobra.Command {
	var profile, name string
	c := &cobra.Command{
		Use:   "delete <date>",
		Short: "Delete previously-pushed [STRIDE] workouts on a date (YYYYMMDD)",
		Long: "Delete previously-pushed [STRIDE] workouts on DATE (YYYYMMDD) from the\n" +
			"watch schedule. Only entries whose program name carries the [STRIDE]\n" +
			"prefix are touched — user-authored watch entries are never deleted.\n" +
			"--name restricts the sweep to an exact program name (e.g. only the\n" +
			"prior push of one session).",
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return runWorkoutDelete(profile, args[0], name)
		},
	}
	c.Flags().StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	c.Flags().StringVar(&name, "name", "", "only delete entries whose program name matches exactly")
	return c
}

func runWorkoutDelete(profile, date, name string) error {
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	isoDate, err := yyyymmddToISO(date)
	if err != nil {
		return err
	}
	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()
	prov, _, err := resolveProvider(store, cfg, user)
	if err != nil {
		return err
	}
	deleted, err := prov.DeleteScheduledWorkout(context.Background(), user, isoDate, name)
	if err != nil {
		return err
	}
	if deleted {
		fmt.Printf("deleted [STRIDE] workout(s) on %s\n", date)
	} else {
		fmt.Printf("no [STRIDE] workout found on %s\n", date)
	}
	return nil
}

func newWatchWorkoutScheduleCmd() *cobra.Command {
	var profile string
	c := &cobra.Command{
		Use:   "schedule <start> <end>",
		Short: "List scheduled workouts in a date range (YYYYMMDD)",
		Args:  cobra.ExactArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			return runWorkoutSchedule(profile, args[0], args[1])
		},
	}
	c.Flags().StringVarP(&profile, "profile", "P", "", "user UUID or slug")
	return c
}

func runWorkoutSchedule(profile, start, end string) error {
	user, err := resolveProfile(profile)
	if err != nil {
		return err
	}
	store, cfg, err := openStore()
	if err != nil {
		return err
	}
	defer store.Close()
	prov, _, err := resolveProvider(store, cfg, user)
	if err != nil {
		return err
	}
	summaries, err := prov.QuerySchedule(context.Background(), user, start, end)
	if err != nil {
		return err
	}
	if len(summaries) == 0 {
		fmt.Println("(no scheduled workouts)")
		return nil
	}
	for _, s := range summaries {
		marker := ""
		if s.IsStrideManaged {
			marker = " [STRIDE]"
		}
		fmt.Printf("%s %-10s %-9s %s%s\n", s.Date, s.ProviderWorkoutID, s.Sport, s.Name, marker)
	}
	fmt.Printf("%d scheduled workout(s) (marked [STRIDE] = STRIDE-managed)\n", len(summaries))
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// flag → normalized workout helpers (mirror the Python CLI convenience
// builders easy_run / tempo_run / interval_run / long_run)
// ─────────────────────────────────────────────────────────────────────────────

func easyRunWorkout(date string, distanceKm float64, paceLow, paceHigh string) provider.RunWorkout {
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   fmt.Sprintf("Easy Run %gkm", distanceKm),
		Date:   date,
		Blocks: []provider.WorkoutBlock{{
			Repeat: 1,
			Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(distanceKm),
				Target:   paceTarget(paceLow, paceHigh),
			}},
		}},
	}
}

func tempoRunWorkout(date string, tempoKm float64, paceLow, paceHigh string) provider.RunWorkout {
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   fmt.Sprintf("Tempo %gkm @ %s", tempoKm, paceHigh),
		Date:   date,
		Blocks: []provider.WorkoutBlock{{
			Repeat: 1,
			Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(tempoKm),
				Target:   paceTarget(paceLow, paceHigh),
			}},
		}},
	}
}

func intervalRunWorkout(date string, reps, intervalM int, paceLow, paceHigh string, recoveryMin float64) provider.RunWorkout {
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   fmt.Sprintf("%dx%dm Intervals", reps, intervalM),
		Date:   date,
		Blocks: []provider.WorkoutBlock{{
			Repeat: reps,
			Steps: []provider.WorkoutStep{
				{
					StepKind: provider.StepWork,
					Duration: provider.DurationOfDistanceM(float64(intervalM)),
					Target:   paceTarget(paceLow, paceHigh),
				},
				{
					StepKind: provider.StepRecovery,
					Duration: provider.DurationOfTimeS(recoveryMin * 60),
				},
			},
		}},
	}
}

func longRunWorkout(date string, totalKm, easyKm, mpKm float64, easyPaceLow, easyPaceHigh, mpPaceLow, mpPaceHigh string) provider.RunWorkout {
	steps := []provider.WorkoutStep{{
		StepKind: provider.StepWork,
		Duration: provider.DurationOfDistanceKM(easyKm),
		Target:   paceTarget(easyPaceLow, easyPaceHigh),
	}}
	if mpKm > 0 {
		steps = append(steps, provider.WorkoutStep{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfDistanceKM(mpKm),
			Target:   paceTarget(mpPaceLow, mpPaceHigh),
		})
	}
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   fmt.Sprintf("Long Run %gkm", totalKm),
		Date:   date,
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: steps}},
	}
}

// paceTarget parses "M:SS" pace strings into a PACE_S_KM range target. On a
// parse error it returns an open target so the workout still pushes (the
// watch just shows no pace band, matching the Python translator's fallback).
func paceTarget(low, high string) provider.Target {
	l, errL := provider.ParsePaceSKM(low)
	h, errH := provider.ParsePaceSKM(high)
	if errL != nil || errH != nil {
		return provider.OpenTarget()
	}
	return provider.PaceRangeSKM(float64(l), float64(h))
}

// ─────────────────────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────────────────────

// yyyymmddToISO converts "20260401" → "2026-04-01" (also passes ISO through).
func yyyymmddToISO(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) == 10 && s[4] == '-' && s[7] == '-' {
		return s, nil
	}
	if len(s) != 8 {
		return "", fmt.Errorf("invalid date %q (want YYYYMMDD)", s)
	}
	if _, err := strconv.Atoi(s); err != nil {
		return "", fmt.Errorf("invalid date %q (want YYYYMMDD)", s)
	}
	return s[:4] + "-" + s[4:6] + "-" + s[6:], nil
}

func orDefault(v, def float64) float64 {
	if v == 0 {
		return def
	}
	return v
}

func orDefaultStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
