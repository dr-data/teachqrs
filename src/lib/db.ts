export type SessionRow = {
  id: number;
  set_id: number;
  name: string;
  join_code: string;
  status: string;
  current_question_id: number | null;
  collecting: number;
  reveal_results: number;
  current_round: number;
  mode: string;
};

export type QuestionRow = {
  id: number;
  set_id: number;
  position: number;
  prompt: string;
  type: string;
  choices_json: string;
  correct: string | null;
  points: number;
  visible: number;
};

export type SetRow = {
  id: number;
  title: string;
  welcome_message: string;
  thanks_message: string;
  mode: string;
};

export type SubclassRow = {
  id: number;
  name: string;
  code: string;
};

export async function one<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...bind)
    .first<T>();
}

export async function many<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...bind)
    .all<T>();
  return result.results ?? [];
}

export async function run(db: D1Database, sql: string, ...bind: unknown[]) {
  return db
    .prepare(sql)
    .bind(...bind)
    .run();
}

export function lastId(result: { meta: { last_row_id: number | string } }): number {
  return Number(result.meta.last_row_id);
}
