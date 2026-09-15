"""
pytest configuration for the process simulator tests.

sim.py is a container entrypoint rather than an installed package, so it is not
importable by name from the repository root. Putting its directory on sys.path
here lets the tests `import sim` exactly as the container does, without adding a
packaging layer that would exist only to satisfy the test runner.

Importing sim.py is safe: every server start is guarded behind __main__, so the
module only defines configuration constants and functions at import time.
"""
import os
import sys

SIM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if SIM_DIR not in sys.path:
    sys.path.insert(0, SIM_DIR)
