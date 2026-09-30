import os
import sys

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)


def pytest_configure(config):
    config.addinivalue_line('markers', 'hardware: needs a real desktop session, audio device or screen reader')
