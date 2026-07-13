import { ConflictError } from "../../../domain/errors.js";
import { User } from "../../../domain/user/User.js";

const USER_COLUMNS = "id, email, password_hash, created_at, updated_at";

function mapUser(row) {
  if (!row) return null;
  return new User({
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export class MySqlUserRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findByEmail(email) {
    const [rows] = await this.pool.execute(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = ? LIMIT 1`,
      [email]
    );
    return mapUser(rows[0]);
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    return mapUser(rows[0]);
  }

  async create({ email, passwordHash }) {
    try {
      const [result] = await this.pool.execute(
        "INSERT INTO users (email, password_hash) VALUES (?, ?)",
        [email, passwordHash]
      );
      return this.findById(result.insertId);
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        throw new ConflictError("EMAIL_ALREADY_REGISTERED", "This email is already registered.");
      }
      throw error;
    }
  }
}
