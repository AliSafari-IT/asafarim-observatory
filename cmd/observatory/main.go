package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"text/tabwriter"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

const version = "0.2.1"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, out, errOut io.Writer) int {
	flags := flag.NewFlagSet("observatory", flag.ContinueOnError)
	flags.SetOutput(errOut)
	root := flags.String("root", ".", "directory containing repository checkouts (direct children only)")
	format := flags.String("format", "table", "output format: table or json")
	timeout := flags.Duration("timeout", 5*time.Second, "maximum scan time per repository")
	showVersion := flags.Bool("version", false, "print version and exit")
	save := flags.Bool("save", false, "save a timestamped JSON snapshot")
	compare := flags.Bool("compare", false, "compare against the latest saved snapshot")
	history := flags.String("history", ".observatory/snapshots", "snapshot history directory (separated by workspace root)")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 || (*format != "table" && *format != "json") || *timeout <= 0 {
		fmt.Fprintln(errOut, "use -root <directory>, -format table|json, and a positive -timeout")
		return 2
	}
	if *showVersion {
		fmt.Fprintln(out, "observatory "+version)
		return 0
	}
	snapshot, err := repository.Scan(ctx, *root, *timeout)
	if err != nil {
		fmt.Fprintln(errOut, "observatory:", err)
		return 1
	}
	var comparison *repository.Comparison
	if *compare {
		previous, loadErr := repository.Latest(*history, snapshot.Root)
		if errors.Is(loadErr, os.ErrNotExist) {
			fmt.Fprintln(errOut, "No previous snapshot; use -save to establish a baseline.")
		} else if loadErr != nil {
			fmt.Fprintln(errOut, "load history:", loadErr)
			return 1
		} else {
			result, compareErr := repository.Compare(previous, snapshot)
			if compareErr != nil {
				fmt.Fprintln(errOut, "compare snapshots:", compareErr)
				return 1
			}
			comparison = &result
		}
	}
	if *format == "json" {
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		if *compare {
			err = encoder.Encode(struct {
				Snapshot   repository.Snapshot    `json:"snapshot"`
				Comparison *repository.Comparison `json:"comparison"`
			}{snapshot, comparison})
		} else {
			err = encoder.Encode(snapshot)
		}
	} else if comparison != nil {
		err = writeComparison(out, *comparison)
	} else {
		err = writeTable(out, snapshot)
	}
	if err != nil {
		fmt.Fprintln(errOut, "write output:", err)
		return 1
	}
	// Save only after loading/comparing, so a scan never compares with itself.
	if *save {
		path, saveErr := repository.Save(*history, snapshot)
		if saveErr != nil {
			fmt.Fprintln(errOut, "save snapshot:", saveErr)
			return 1
		}
		fmt.Fprintln(errOut, "Saved snapshot:", path)
	}
	for _, repo := range snapshot.Repositories {
		if repo.Error != "" {
			return 1
		}
	}
	return 0
}

func writeTable(out io.Writer, snapshot repository.Snapshot) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "REPOSITORY\tBRANCH\tCHANGED FILES\tSTATUS")
	for _, repo := range snapshot.Repositories {
		status := "clean"
		changes := strconv.Itoa(repo.ChangedFiles)
		if repo.ChangedFiles > 0 {
			status = "uncommitted changes"
		}
		if repo.Error != "" {
			status = repo.Error
			changes = "?"
		}
		// Quoting prevents control characters in directory names from altering
		// the terminal display, without changing the machine-readable JSON.
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", strconv.Quote(repo.Name), strconv.Quote(repo.Branch), changes, status)
	}
	if len(snapshot.Repositories) == 0 {
		fmt.Fprintln(w, "(no repositories found)")
	}
	return w.Flush()
}

func writeComparison(out io.Writer, comparison repository.Comparison) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "REPOSITORY\tCHANGE\tBEFORE\tAFTER")
	for _, change := range comparison.Changes {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", strconv.Quote(change.Name), change.Kind, observation(change.Before), observation(change.After))
	}
	if len(comparison.Changes) == 0 {
		fmt.Fprintln(w, "(no observed branch or changed-file-count changes)")
	}
	return w.Flush()
}

func observation(repo *repository.Repository) string {
	if repo == nil {
		return "-"
	}
	if repo.Error != "" {
		return "unavailable: " + strconv.Quote(repo.Error)
	}
	return fmt.Sprintf("%s (%d changed files)", strconv.Quote(repo.Branch), repo.ChangedFiles)
}
