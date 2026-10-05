from arq import create_pool
from arq.worker import Worker

from app.workers.main import WorkerSettings

QUEUE = "worktrack:test"


async def test_ping_job_runs_through_the_worker() -> None:
    pool = await create_pool(WorkerSettings.redis_settings, default_queue_name=QUEUE)
    job = await pool.enqueue_job("ping")
    assert job is not None
    worker = Worker(
        functions=WorkerSettings.functions,
        redis_settings=WorkerSettings.redis_settings,
        queue_name=QUEUE,
        burst=True,
    )
    try:
        await worker.main()
        assert await job.result(timeout=5) == "pong"
    finally:
        # Worker.close() calls redis-py's deprecated pool.close() (arq 0.28.0, latest), so close
        # the pools directly. Burst mode has already drained every task by the time main() returns.
        await worker.pool.aclose()
        await pool.aclose()


def test_the_daily_clean_up_jobs_are_scheduled() -> None:
    scheduled = {job.name for job in WorkerSettings.cron_jobs}
    assert {"cron:purge_sessions", "cron:purge_faces"} <= scheduled
    assert {"purge_sessions", "purge_faces"} <= {f.__name__ for f in WorkerSettings.functions}
