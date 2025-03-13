"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChronoInMemoryDataStore = void 0;
const node_crypto_1 = require("node:crypto");
class ChronoInMemoryDataStore {
    store = new Map();
    schedule(input, _options) {
        const id = (0, node_crypto_1.randomUUID)();
        const task = {
            id,
            type: input.type,
            data: input.data,
            status: "PENDING",
            scheduledAt: input.scheduledAt,
            retryCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.store.set(id, task);
        return Promise.resolve(task);
    }
    unschedule(taskId, _options) {
        const task = this.store.get(taskId);
        if (task) {
            this.store.delete(taskId);
        }
        return Promise.resolve(task);
    }
    claim(input, options) {
        const now = new Date();
        const task = [...this.store.values()]
            .filter((task) => (task.status === "PENDING" && task.scheduledAt <= now) ||
            (task.status === "CLAIMED" &&
                task.scheduledAt <= now &&
                task.claimedAt &&
                task.claimedAt.getTime() <= now.getTime() + 10000))
            .sort((a, b) => a.priority - b.priority ||
            a.createdAt.getTime() - b.createdAt.getTime())
            .pop();
        throw new Error("Method not implemented.");
    }
    unclaim(input, options) {
        throw new Error("Method not implemented.");
    }
    complete(input, options) {
        throw new Error("Method not implemented.");
    }
}
exports.ChronoInMemoryDataStore = ChronoInMemoryDataStore;
//# sourceMappingURL=index.js.map