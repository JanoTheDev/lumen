"""Protocol error codes (plans CONTRACTS C2)."""

E_TIMEOUT = "E_TIMEOUT"
E_CANCELLED = "E_CANCELLED"
E_NOT_FOUND = "E_NOT_FOUND"
E_DENIED = "E_DENIED"
E_UNSUPPORTED = "E_UNSUPPORTED"
E_INVALID = "E_INVALID"
E_INTERNAL = "E_INTERNAL"


class AgentError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
