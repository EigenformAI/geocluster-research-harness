"""
Training session state management.

Captures user questions and tool calls during specialist execution
for hypothesis generation and evaluation.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional
from threading import Lock


@dataclass
class ToolCall:
    """Record of a single MCP tool invocation."""
    tool: str
    args: dict
    result: Any
    timestamp: float = field(default_factory=time.time)
    
    def to_dict(self) -> dict:
        return {
            "tool": self.tool,
            "args": self.args,
            "result": self.result,
            "timestamp": self.timestamp,
        }
    
    def to_code_repr(self) -> str:
        """Convert to pseudo-code representation for hypothesis prompt."""
        args_str = ", ".join(f"{k}={repr(v)}" for k, v in self.args.items())
        return f"{self.tool}({args_str})"


@dataclass
class TrainingSession:
    """
    Captures state for a single training data collection session.
    
    Lifecycle:
    1. Created when qualifying analysis begins
    2. Tool calls recorded during execution
    3. Hypotheses generated (model doesn't see results)
    4. Hypotheses evaluated against actual results
    5. Session finalized and saved
    """
    session_id: str
    question: str
    created_at: float = field(default_factory=time.time)
    tool_calls: list[ToolCall] = field(default_factory=list)
    hypotheses: list[dict] = field(default_factory=list)
    evaluation_results: Optional[dict] = None
    finalized: bool = False
    
    # Metadata
    user_id: Optional[str] = None
    project_id: Optional[str] = None
    specialist_type: Optional[str] = None
    
    def record_call(self, tool: str, args: dict, result: Any) -> None:
        """Record a tool call during this session."""
        if self.finalized:
            raise ValueError(f"Session {self.session_id} is already finalized")
        self.tool_calls.append(ToolCall(tool=tool, args=args, result=result))
    
    def get_code_context(self, include_results: bool = False) -> str:
        """
        Generate code representation of tool calls.
        
        Args:
            include_results: If True, include actual results (for evaluation).
                           If False, hide results (for hypothesis generation).
        """
        lines = []
        for i, call in enumerate(self.tool_calls, 1):
            code = call.to_code_repr()
            if include_results:
                # Truncate large results
                result_str = str(call.result)
                if len(result_str) > 500:
                    result_str = result_str[:500] + "..."
                lines.append(f"# Step {i}\nresult_{i} = {code}\n# Result: {result_str}")
            else:
                lines.append(f"# Step {i}\nresult_{i} = {code}")
        return "\n\n".join(lines)
    
    def get_final_result(self) -> Any:
        """Get the result of the last tool call (the 'answer')."""
        if not self.tool_calls:
            return None
        return self.tool_calls[-1].result
    
    def to_dict(self) -> dict:
        """Serialize session for storage."""
        return {
            "session_id": self.session_id,
            "question": self.question,
            "created_at": self.created_at,
            "tool_calls": [tc.to_dict() for tc in self.tool_calls],
            "hypotheses": self.hypotheses,
            "evaluation_results": self.evaluation_results,
            "finalized": self.finalized,
            "user_id": self.user_id,
            "project_id": self.project_id,
            "specialist_type": self.specialist_type,
        }


class SessionManager:
    """
    Thread-safe manager for active training sessions.
    
    Maintains a registry of active sessions and provides
    hooks for automatic tool call capture.
    """
    
    def __init__(self):
        self._sessions: dict[str, TrainingSession] = {}
        self._active_session_id: Optional[str] = None
        self._lock = Lock()
        
        # Tools that qualify for training data capture
        # (tools that perform actual analysis, not just inspection)
        self._qualifying_tools = {
            # Clustering & dimensionality
            "cluster", "reduce_dimensions",
            # Anomaly detection
            "compute_anomaly", "threshold", "rank_by_metric",
            # Transforms that produce insights
            "compute_ratios", "aggregate", "band_math",
            # Correlations and queries that answer questions
            "query_data", "profile_geochem",
            # Visualization (the output is the insight)
            "plot_scatter", "plot_map", "plot_histogram", "plot_clusters",
        }
    
    def start_session(
        self,
        question: str,
        user_id: Optional[str] = None,
        project_id: Optional[str] = None,
        specialist_type: Optional[str] = None,
    ) -> TrainingSession:
        """Start a new training session."""
        session_id = f"ts_{int(time.time())}_{uuid.uuid4().hex[:8]}"
        
        session = TrainingSession(
            session_id=session_id,
            question=question,
            user_id=user_id or os.environ.get("USER_ID"),
            project_id=project_id or os.environ.get("PROJECT_ID"),
            specialist_type=specialist_type,
        )
        
        with self._lock:
            self._sessions[session_id] = session
            self._active_session_id = session_id
        
        return session
    
    def get_session(self, session_id: str) -> Optional[TrainingSession]:
        """Get a session by ID."""
        with self._lock:
            return self._sessions.get(session_id)
    
    def get_active_session(self) -> Optional[TrainingSession]:
        """Get the currently active session."""
        with self._lock:
            if self._active_session_id:
                return self._sessions.get(self._active_session_id)
            return None
    
    def record_tool_call(self, tool: str, args: dict, result: Any) -> bool:
        """
        Record a tool call to the active session if one exists.
        
        Returns True if the call was recorded, False otherwise.
        """
        session = self.get_active_session()
        if session and not session.finalized:
            session.record_call(tool, args, result)
            return True
        return False
    
    def is_qualifying_tool(self, tool: str) -> bool:
        """Check if a tool qualifies for training data capture."""
        return tool in self._qualifying_tools
    
    def end_session(self, session_id: str) -> Optional[TrainingSession]:
        """
        End a session and remove it from active tracking.
        
        The session object is returned for finalization/storage.
        """
        with self._lock:
            session = self._sessions.pop(session_id, None)
            if self._active_session_id == session_id:
                self._active_session_id = None
            return session
    
    def clear_active(self) -> None:
        """Clear the active session without removing it from registry."""
        with self._lock:
            self._active_session_id = None


# Global session manager instance
_manager: Optional[SessionManager] = None


def get_session_manager() -> SessionManager:
    """Get or create the global session manager."""
    global _manager
    if _manager is None:
        _manager = SessionManager()
    return _manager
