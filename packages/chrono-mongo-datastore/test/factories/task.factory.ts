import { faker } from '@faker-js/faker';
import { type Task, type TaskMappingBase, TaskStatus } from '@neofinancial/chrono';
import { Factory } from 'fishery';

export const defineTaskFactory = <TaskMapping extends TaskMappingBase, TaskKind extends keyof TaskMapping>(
  taskKind: TaskKind,
  defaultTaskData: TaskMapping[TaskKind],
): Factory<Task<TaskKind, TaskMapping[TaskKind]>> =>
  Factory.define<Task<TaskKind, TaskMapping[TaskKind]>>((): Task<TaskKind, TaskMapping[TaskKind]> => {
    return {
      id: faker.database.mongodbObjectId(),
      kind: taskKind,
      status: faker.helpers.objectValue(TaskStatus),
      data: defaultTaskData,
      scheduledAt: faker.date.past(),
      originalScheduleDate: faker.date.past(),
      retryCount: 0,
    };
  });
