"""
Fails if the pymodbus version the tests install differs from the one the
process-sim image installs.

Why this check exists: the unit tests subclass ModbusSlaveContext and override
getValues/setValues. Run against a different pymodbus release, they would verify
an API the shipped container does not run, and would keep passing while the real
image drifted. A comment asking the next person to keep two files in sync is not
enforcement; this is.

Run directly from the repository root:
    python scripts/check_pymodbus_pin.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCKERFILE = os.path.join(ROOT, "containers", "process-sim", "Dockerfile")
REQUIREMENTS = os.path.join(ROOT, "containers", "process-sim", "requirements-dev.txt")

# Matches pymodbus==X.Y.Z wherever it appears on a line, so it works for both
# the Dockerfile's quoted pip argument and the plain requirements line.
PIN = re.compile(r"pymodbus==([0-9][0-9.]*)")


def read_pin(path: str) -> str:
    """Returns the first pymodbus pin in the file, or '' when there is none."""
    try:
        with open(path, encoding="utf-8") as handle:
            match = PIN.search(handle.read())
    except OSError as exc:
        print("ERROR: cannot read %s: %s" % (path, exc))
        return ""
    return match.group(1) if match else ""


def main() -> int:
    docker_pin = read_pin(DOCKERFILE)
    dev_pin = read_pin(REQUIREMENTS)

    print("Dockerfile        : %s" % (docker_pin or "<not found>"))
    print("requirements-dev  : %s" % (dev_pin or "<not found>"))

    # A missing pin must fail rather than compare equal to another missing pin,
    # which would let a broken pattern report agreement.
    if not docker_pin or not dev_pin:
        print("ERROR: could not read a pymodbus pin from both files")
        return 1

    if docker_pin != dev_pin:
        print("ERROR: pymodbus pin drift - the tests would not exercise the "
              "version the image ships")
        return 1

    print("OK: pins match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
