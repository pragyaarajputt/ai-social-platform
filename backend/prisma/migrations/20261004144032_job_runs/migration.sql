-- CreateTable
CREATE TABLE "job_runs" (
    "name" VARCHAR(40) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("name")
);
