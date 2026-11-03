/**
 * The only module that spawns and signals processes. Children are spawned
 * detached and `shell: false`, tracked here, and killed as process groups on
 * shutdown. Task 8 adds the spawn/track API; this scaffold provides `stopAll`
 * so the server has a single shutdown hook from the start.
 */

/** Stop every tracked child process group. A no-op until children are tracked (task 8). */
export async function stopAll(_graceMs = 500): Promise<void> {
  // No children are tracked yet; the runner (task 8) will register them here.
}
