import { faker } from '@faker-js/faker';
import { Factory } from 'fishery';

import { type Task, type TaskMappingBase, TaskStatus } from '../../src';

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
