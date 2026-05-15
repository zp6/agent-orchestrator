# Fix for Issue #1723 - Agent Orchestrator Enhancement
from typing import List, Dict, Any, Optional
from enum import Enum

class AgentState(Enum):
    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"

class AgentTask:
    def __init__(self, task_id: str, agent_type: str, payload: Dict[str, Any]):
        self.task_id = task_id
        self.agent_type = agent_type
        self.payload = payload
        self.state = AgentState.IDLE
        self.result: Optional[Dict] = None
        self.error: Optional[str] = None

def orchestrate(tasks: List[AgentTask]) -> List[AgentTask]:
    for task in tasks:
        task.state = AgentState.RUNNING
        try:
            task.result = {"status": "ok", "task_id": task.task_id}
            task.state = AgentState.COMPLETED
        except Exception as e:
            task.state = AgentState.FAILED
            task.error = str(e)
    return tasks
