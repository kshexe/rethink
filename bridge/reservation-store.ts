/*
 * Where a driver that runs the LG app's on/off reservation itself keeps it.
 *
 * What is stored is the absolute wall-clock deadline, not the minutes that were asked for: a
 * restart is not a reason for a two-hour timer to start again from two hours. A deadline already
 * in the past is dropped on load rather than fired late - the appliance has been left alone for
 * however long rethink was down, and switching it on the moment rethink comes back would be
 * acting on an intent that expired.
 */
export type ReservationDeadlines = {
    start?: number
    stop?: number
}

export type ReservationStore = {
    load(id: string): ReservationDeadlines
    save(id: string, deadlines: ReservationDeadlines): void
}
