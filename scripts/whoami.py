#!/usr/bin/env python3
"""Print all AGENTROOM_* environment variables as a two-column table."""

import os
import sys


def main() -> int:
    entries = sorted(
        (k, v) for k, v in os.environ.items() if k.startswith("AGENTROOM_")
    )

    if not entries:
        print("No AGENTROOM_* environment variables set.", file=sys.stderr)
        return 1

    key_width = max(len(k) for k, _ in entries)
    for key, value in entries:
        print(f"{key.rjust(key_width)}  {value}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
