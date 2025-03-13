import type { ClaimInput, CompleteInput, DataStore, ScheduleInput, Task, UnClaimInput } from "@neofinancial/chrono-core";
interface ChronoInMemoryDataStoreOptions {
    name: "ChronoInMemoryDataStore";
}
export declare class ChronoInMemoryDataStore implements DataStore<ChronoInMemoryDataStoreOptions> {
    private store;
    schedule(input: ScheduleInput<object>, _options: ChronoInMemoryDataStoreOptions): Promise<Task<object>>;
    unschedule(taskId: string, _options: ChronoInMemoryDataStoreOptions): Promise<Task<object> | undefined>;
    claim(input: ClaimInput, options: ChronoInMemoryDataStoreOptions): Promise<Task<object>>;
    unclaim(input: UnClaimInput, options: ChronoInMemoryDataStoreOptions): Promise<Task<object> | undefined>;
    complete(input: CompleteInput, options: ChronoInMemoryDataStoreOptions): Promise<Task<object>>;
}
export {};
