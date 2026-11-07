package main

import (
	"context"
	"encoding/json"
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

const version = "0.1.0"

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
	if *format == "json" {
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		err = encoder.Encode(snapshot)
	} else {
		err = writeTable(out, snapshot)
	}
	if err != nil {
		fmt.Fprintln(errOut, "write output:", err)
		return 1
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
