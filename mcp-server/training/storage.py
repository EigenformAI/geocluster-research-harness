"""
Training data storage.

Persists training sessions as JSONL files for SFT training.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Optional, Iterator

from .session import TrainingSession
from .evaluator import StructuredHypothesis


@dataclass
class TrainingSample:
    """A single training sample (prompt + completion)."""
    prompt: str
    completion: str
    specificity_score: int
    correct: bool
    session_id: str
    hypothesis_index: int
    
    # Optional metadata
    claim_type: Optional[str] = None
    actual_value: Optional[str] = None
    
    def to_dict(self) -> dict:
        return {
            "prompt": self.prompt,
            "completion": self.completion,
            "specificity_score": self.specificity_score,
            "correct": self.correct,
            "session_id": self.session_id,
            "hypothesis_index": self.hypothesis_index,
            "claim_type": self.claim_type,
            "actual_value": str(self.actual_value) if self.actual_value is not None else None,
        }
    
    def to_jsonl(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)


class TrainingDataStorage:
    """
    Manages storage of training data.
    
    Saves to JSONL format with separate files for:
    - correct hypotheses (for SFT)
    - rejected hypotheses (for reference/future DPO)
    - full session logs (for debugging)
    """
    
    def __init__(self, base_dir: str = None):
        """
        Args:
            base_dir: Base directory for training data.
                     Defaults to {workspace}/training_data/
        """
        if base_dir:
            self.base_dir = base_dir
        else:
            workspace = os.environ.get("MCP_WORKSPACE_ROOT", os.getcwd())
            self.base_dir = os.path.join(workspace, "training_data")
        
        self._ensure_dirs()
    
    def _ensure_dirs(self) -> None:
        """Create directory structure."""
        os.makedirs(self.base_dir, exist_ok=True)
        os.makedirs(os.path.join(self.base_dir, "correct"), exist_ok=True)
        os.makedirs(os.path.join(self.base_dir, "rejected"), exist_ok=True)
        os.makedirs(os.path.join(self.base_dir, "sessions"), exist_ok=True)
    
    def build_prompt(self, session: TrainingSession) -> str:
        """
        Build the prompt for hypothesis generation/training.
        
        This is the input that the model sees (question + code, no results).
        """
        code_context = session.get_code_context(include_results=False)
        
        prompt = f"""You are a geological data analyst. Given the following question and the operations that were executed to answer it, predict what the results will show.

**Question:** {session.question}

**Operations executed:**
```python
{code_context}
```

Provide a specific, testable prediction about the output. Be concrete - include numbers, directions, or ranges where applicable."""
        
        return prompt
    
    def session_to_samples(
        self,
        session: TrainingSession,
        hypotheses: list[StructuredHypothesis],
    ) -> tuple[list[TrainingSample], list[TrainingSample]]:
        """
        Convert a session and its evaluated hypotheses to training samples.
        
        Returns:
            (correct_samples, rejected_samples)
        """
        prompt = self.build_prompt(session)
        correct = []
        rejected = []
        
        for i, h in enumerate(hypotheses):
            if h.is_correct is None:
                # Skip hypotheses that couldn't be evaluated
                continue
            
            sample = TrainingSample(
                prompt=prompt,
                completion=h.text,
                specificity_score=h.specificity_score,
                correct=h.is_correct,
                session_id=session.session_id,
                hypothesis_index=i,
                claim_type=h.claim_type.value if h.claim_type else None,
                actual_value=h.actual_value,
            )
            
            if h.is_correct:
                correct.append(sample)
            else:
                rejected.append(sample)
        
        return correct, rejected
    
    def save_session(
        self,
        session: TrainingSession,
        hypotheses: list[StructuredHypothesis],
    ) -> dict:
        """
        Save a completed training session.
        
        Returns:
            Summary of what was saved.
        """
        correct_samples, rejected_samples = self.session_to_samples(session, hypotheses)
        
        timestamp = int(time.time())
        
        # Save correct samples (for SFT)
        correct_path = os.path.join(
            self.base_dir, "correct", f"{session.session_id}.jsonl"
        )
        with open(correct_path, "w") as f:
            for sample in correct_samples:
                f.write(sample.to_jsonl() + "\n")
        
        # Save rejected samples (for reference)
        rejected_path = os.path.join(
            self.base_dir, "rejected", f"{session.session_id}.jsonl"
        )
        with open(rejected_path, "w") as f:
            for sample in rejected_samples:
                f.write(sample.to_jsonl() + "\n")
        
        # Save full session log
        session_path = os.path.join(
            self.base_dir, "sessions", f"{session.session_id}.json"
        )
        session_data = session.to_dict()
        session_data["hypotheses_evaluated"] = [h.to_dict() for h in hypotheses]
        with open(session_path, "w") as f:
            json.dump(session_data, f, indent=2, ensure_ascii=False)
        
        return {
            "session_id": session.session_id,
            "correct_count": len(correct_samples),
            "rejected_count": len(rejected_samples),
            "unevaluated_count": len(hypotheses) - len(correct_samples) - len(rejected_samples),
            "correct_path": correct_path,
            "rejected_path": rejected_path,
            "session_path": session_path,
            "avg_specificity_correct": (
                sum(s.specificity_score for s in correct_samples) / len(correct_samples)
                if correct_samples else 0
            ),
            "avg_specificity_rejected": (
                sum(s.specificity_score for s in rejected_samples) / len(rejected_samples)
                if rejected_samples else 0
            ),
        }
    
    def merge_correct_samples(self, output_path: str = None) -> str:
        """
        Merge all correct samples into a single JSONL file for training.
        
        Returns:
            Path to merged file.
        """
        if output_path is None:
            output_path = os.path.join(self.base_dir, "sft_training_data.jsonl")
        
        correct_dir = os.path.join(self.base_dir, "correct")
        
        with open(output_path, "w") as out:
            for filename in sorted(os.listdir(correct_dir)):
                if filename.endswith(".jsonl"):
                    filepath = os.path.join(correct_dir, filename)
                    with open(filepath) as f:
                        for line in f:
                            out.write(line)
        
        return output_path
    
    def get_stats(self) -> dict:
        """Get statistics about stored training data."""
        correct_dir = os.path.join(self.base_dir, "correct")
        rejected_dir = os.path.join(self.base_dir, "rejected")
        sessions_dir = os.path.join(self.base_dir, "sessions")
        
        def count_lines(directory: str) -> int:
            total = 0
            if os.path.exists(directory):
                for f in os.listdir(directory):
                    if f.endswith(".jsonl"):
                        with open(os.path.join(directory, f)) as fp:
                            total += sum(1 for _ in fp)
            return total
        
        def count_files(directory: str, ext: str) -> int:
            if os.path.exists(directory):
                return len([f for f in os.listdir(directory) if f.endswith(ext)])
            return 0
        
        return {
            "total_sessions": count_files(sessions_dir, ".json"),
            "total_correct_samples": count_lines(correct_dir),
            "total_rejected_samples": count_lines(rejected_dir),
            "base_dir": self.base_dir,
        }
    
    def iter_correct_samples(self) -> Iterator[TrainingSample]:
        """Iterate over all correct samples."""
        correct_dir = os.path.join(self.base_dir, "correct")
        if not os.path.exists(correct_dir):
            return
        
        for filename in sorted(os.listdir(correct_dir)):
            if filename.endswith(".jsonl"):
                filepath = os.path.join(correct_dir, filename)
                with open(filepath) as f:
                    for line in f:
                        data = json.loads(line)
                        yield TrainingSample(**data)
