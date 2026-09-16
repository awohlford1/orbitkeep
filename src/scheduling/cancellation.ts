import type { AssignmentAggregate, TaskState } from "../commands/types.ts";
import { validateTaskGraph } from "./eligibility.ts";

export interface TaskCancellationImpact {
  rootTaskId: string;
  affectedTasks: TaskState[];
  activeExecutionIds: string[];
  preservedTerminalTaskIds: string[];
}

/** Required dependency edges propagate cancellation downstream; optional edges do not. */
export function taskCancellationImpact(assignment: AssignmentAggregate, rootTaskId: string): TaskCancellationImpact {
  validateTaskGraph(assignment.tasks);
  if (!assignment.tasks.some((task) => task.taskId === rootTaskId)) throw new Error("Task not found");
  const affected = new Set([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of assignment.tasks) {
      if (affected.has(task.taskId) || !(task.dependencies ?? []).some((dependency) => dependency.required && affected.has(dependency.taskId))) continue;
      affected.add(task.taskId); changed = true;
    }
  }
  const affectedTasks = assignment.tasks.filter((task) => affected.has(task.taskId));
  const activeTaskIds = new Set(affectedTasks.map((task) => task.taskId));
  return {
    rootTaskId,
    affectedTasks: affectedTasks.map((task) => structuredClone(task)),
    activeExecutionIds: assignment.executions.filter((execution) => activeTaskIds.has(execution.taskId) && execution.state === "running").map((execution) => execution.executionId),
    preservedTerminalTaskIds: affectedTasks.filter((task) => task.state === "accepted" || task.state === "closed" || task.state === "skipped").map((task) => task.taskId),
  };
}
