#!/usr/bin/env python3
"""Check the signed app bytes against the native permissions declared by Xcode."""

import argparse
import plistlib
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app")
    parser.add_argument("entitlements")
    args = parser.parse_args()
    with open(args.entitlements, "rb") as source:
        expected = plistlib.load(source)
    result = subprocess.run(
        ["codesign", "-d", "--entitlements", "-", "--xml", args.app],
        capture_output=True,
        check=True,
    )
    if not result.stdout.strip():
        raise ValueError("No signed entitlements in app")
    actual = plistlib.loads(result.stdout)
    mismatches = [key for key, value in expected.items() if actual.get(key) != value]
    if mismatches:
        raise ValueError("Missing or changed app entitlements: " + ", ".join(mismatches))
    print("Mac app entitlements verified")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
