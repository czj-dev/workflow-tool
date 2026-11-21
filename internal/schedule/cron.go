package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

const maxCronExpressionBytes = 512

// Cron holds immutable field masks for a five-field, minute-granularity expression.
// Weekdays follow time.Weekday: Sunday=0, Monday=1.
type Cron struct {
	minute, hour, day, month, weekday uint64
	dayWildcard, weekdayWildcard      bool
}

func Parse(expr string) (Cron, error) {
	if len(expr) > maxCronExpressionBytes {
		return Cron{}, fmt.Errorf("cron: expression exceeds %d bytes", maxCronExpressionBytes)
	}
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return Cron{}, fmt.Errorf("cron: expected 5 fields, got %d", len(fields))
	}
	bounds := [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}
	var masks [5]uint64
	for i, field := range fields {
		mask, err := parseField(field, bounds[i][0], bounds[i][1])
		if err != nil {
			return Cron{}, fmt.Errorf("cron field %d (%q): %w", i+1, field, err)
		}
		masks[i] = mask
	}
	return Cron{
		minute: masks[0], hour: masks[1], day: masks[2], month: masks[3], weekday: masks[4],
		dayWildcard: fields[2] == "*", weekdayWildcard: fields[4] == "*",
	}, nil
}

func parseField(field string, min, max int) (uint64, error) {
	if strings.Contains(field, "/") {
		return 0, fmt.Errorf("step expressions are not supported")
	}
	if field == "*" {
		return (uint64(1) << (max + 1)) - (uint64(1) << min), nil
	}
	var mask uint64
	for _, item := range strings.Split(field, ",") {
		startText, endText, isRange := strings.Cut(item, "-")
		if !isRange {
			endText = startText
		}
		start, startErr := strconv.Atoi(startText)
		end, endErr := strconv.Atoi(endText)
		if strings.Trim(startText+endText, "0123456789") != "" ||
			startErr != nil || endErr != nil || start < min || end > max || start > end {
			return 0, fmt.Errorf("invalid value or range %q (allowed %d-%d)", item, min, max)
		}
		for value := start; value <= end; value++ {
			mask |= uint64(1) << value
		}
	}
	return mask, nil
}

// Matches compares the five calendar fields; seconds and subseconds are ignored.
// Vixie day semantics: restricted day-of-month and weekday use OR; if either
// field is *, only the other field constrains the day.
func (c Cron) Matches(t time.Time) bool {
	if c.minute&(uint64(1)<<t.Minute()) == 0 ||
		c.hour&(uint64(1)<<t.Hour()) == 0 ||
		c.month&(uint64(1)<<int(t.Month())) == 0 {
		return false
	}
	dayMatches := c.day&(uint64(1)<<t.Day()) != 0
	weekdayMatches := c.weekday&(uint64(1)<<int(t.Weekday())) != 0
	if !c.dayWildcard && !c.weekdayWildcard {
		return dayMatches || weekdayMatches
	}
	return dayMatches && weekdayMatches
}

// NextAfter searches local minute boundaries after t within one calendar year.
// Skipped DST minutes do not run; repeated DST minutes may run twice.
// ponytail: bounded minute scanning keeps the engine simple; optimize only if needed.
func (c Cron) NextAfter(t time.Time) (time.Time, bool) {
	limit := t.AddDate(1, 0, 0)
	for candidate := nextLocalMinute(t); !candidate.After(limit); candidate = nextLocalMinute(candidate) {
		if c.Matches(candidate) {
			return candidate, true
		}
	}
	return time.Time{}, false
}

func nextLocalMinute(t time.Time) time.Time {
	return t.Add(time.Minute - time.Duration(t.Second())*time.Second - time.Duration(t.Nanosecond()))
}
