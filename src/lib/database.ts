import { env } from '../env.js';

export const isPostgres = /^postgres(ql)?:\/\//i.test(env.DATABASE_URL);
