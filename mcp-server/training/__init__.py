"""
Training data collection module for geological intuition learning.

Captures user questions, code/operations executed, and generates
structured hypotheses for SFT training data.
"""

from .session import TrainingSession, SessionManager
from .evaluator import HypothesisEvaluator, StructuredHypothesis
from .storage import TrainingDataStorage

__all__ = [
    "TrainingSession",
    "SessionManager", 
    "HypothesisEvaluator",
    "StructuredHypothesis",
    "TrainingDataStorage",
]
