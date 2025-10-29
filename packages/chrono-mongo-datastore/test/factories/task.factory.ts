import { faker } from '@faker-js/faker';
import { type Task, type TaskMappingBase, TaskStatus } from '@neofinancial/chrono';
import { Factory } from 'fishery';

export const defineTaskFactory = <TaskMapping extends TaskMappingBase>(
  taskKind: keyof TaskMapping,
  defaultTaskData: TaskMapping[keyof TaskMapping],
) =>
  Factory.define<Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]>>(
    (): Task<keyof TaskMapping, TaskMapping[keyof TaskMapping]> => {
      return {
        id: faker.database.mongodbObjectId(),
        kind: taskKind,
        status: faker.helpers.objectValue(TaskStatus),
        data: defaultTaskData,
        scheduledAt: faker.date.past(),
        originalScheduleDate: faker.date.past(),
        retryCount: faker.number.int({ min: 0, max: 5 }),
      };
    },
  );
