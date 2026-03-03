import express from "express";
import pg from "pg";
import bcrypt from "bcrypt";
import axios from "axios";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ========= PANEL ADMIN ========= */

app.get("/", async (req, res) => {
  res.send(`
    <h2>Panel IPTV Profesional</h2>

    <h3>Importar M3U</h3>
    <form method="POST" action="/admin/import">
      <input name="m3u_url" placeholder="Pega URL M3U aquí" style="width:400px"/>
      <button type="submit">Importar</button>
    </form>

    <h3>Crear Usuario</h3>
    <form method="POST" action="/admin/create-user">
      <input name="username" placeholder="Usuario"/>
      <input name="password" placeholder="Contraseña"/>
      <input name="days" placeholder="Días duración"/>
      <input name="max_connections" placeholder="Conexiones"/>
      <button type="submit">Crear</button>
    </form>

    <p>Xtream API:</p>
    <p>/player_api.php?username=USER&password=PASS</p>
  `);
});

/* ========= IMPORTAR M3U ========= */

app.post("/admin/import", async (req, res) => {
  const { m3u_url } = req.body;

  const response = await axios.get(m3u_url);
  const lines = response.data.split("\n");

  await pool.query("DELETE FROM channels");

  let name = "";
  let category = "";

  for (let line of lines) {
    if (line.startsWith("#EXTINF")) {
      name = line.split(",")[1];
      const groupMatch = line.match(/group-title="(.*?)"/);
      category = groupMatch ? groupMatch[1] : "General";
    } else if (line.startsWith("http")) {
      await pool.query(
        "INSERT INTO channels(name,stream_url,category) VALUES($1,$2,$3)",
        [name, line.trim(), category]
      );
    }
  }

  res.send("M3U Importada Correctamente <br><a href='/'>Volver</a>");
});

/* ========= CREAR USUARIO ========= */

app.post("/admin/create-user", async (req, res) => {
  const { username, password, days, max_connections } = req.body;

  const hash = await bcrypt.hash(password, 10);
  const exp = Math.floor(Date.now() / 1000) + (days * 86400);

  await pool.query(
    "INSERT INTO users(username,password,exp_date,max_connections) VALUES($1,$2,$3,$4)",
    [username, hash, exp, max_connections]
  );

  res.send("Usuario creado <br><a href='/'>Volver</a>");
});

/* ========= XTREAM ========= */

async function validateUser(username, password) {
  const result = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (result.rows.length === 0) return null;

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return null;

  return user;
}

app.get("/player_api.php", async (req, res) => {
  const { username, password } = req.query;
  const user = await validateUser(username, password);

  if (!user) return res.json({ user_info: { auth: 0 } });

  res.json({
    user_info: {
      auth: 1,
      username: user.username,
      exp_date: user.exp_date
    }
  });
});

app.get("/get.php", async (req, res) => {
  const { username, password, type } = req.query;
  const user = await validateUser(username, password);
  if (!user) return res.status(403).send("Denied");

  if (type === "m3u") {
    const channels = await pool.query("SELECT * FROM channels");

    let m3u = "#EXTM3U\n";
    channels.rows.forEach(ch => {
      m3u += `#EXTINF:-1 group-title="${ch.category}",${ch.name}\n`;
      m3u += `${ch.stream_url}\n`;
    });

    res.setHeader("Content-Type", "application/x-mpegURL");
    res.send(m3u);
  }
});

app.listen(process.env.PORT);