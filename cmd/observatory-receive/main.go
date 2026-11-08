package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func run(args []string, input io.Reader, out, errOut io.Writer) int {
	flags := flag.NewFlagSet("observatory-receive", flag.ContinueOnError)
	flags.SetOutput(errOut)
	root := flags.String("root", "", "expected sender workspace root (required; does not need to exist on server)")
	history := flags.String("history", "", "destination history directory (required)")
	version := flags.Bool("version", false, "print version and exit")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if *version {
		fmt.Fprintln(out, "observatory-receive 0.1.0")
		return 0
	}
	if flags.NArg() != 0 || *root == "" || *history == "" {
		fmt.Fprintln(errOut, "-root and -history are required")
		return 2
	}
	duplicate, err := repository.Receive(input, *root, *history)
	if err != nil {
		fmt.Fprintln(errOut, "Snapshot rejected or could not be stored.")
		return 1
	}
	if err := json.NewEncoder(out).Encode(map[string]any{"status": "saved", "duplicate": duplicate}); err != nil {
		return 1
	}
	return 0
}
