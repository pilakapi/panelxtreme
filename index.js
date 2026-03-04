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
      <input name="m3u_url" placeholder="Pega URL M3U aquí" style="width:400px" required/>
      <button type="submit">Importar</button>
    </form>

    <h3>Crear / Reactivar Usuario</h3>
    <form method="POST" action="/admin/create-user">
      <input name="username" placeholder="Usuario" required/>
      <input name="password" placeholder="Contraseña" required/>
      <input name="days" placeholder="Días duración (vacío = ilimitado)"/>
      <input name="max_connections" placeholder="Conexiones" value="1"/>
      <button type="submit">Crear / Reactivar</button>
    </form>

    <p><b>URL Xtream para IPTV Smarters:</b></p>
    <p>${req.protocol}://${req.get("host")}</p>
  `);
});

/* ========= IMPORTAR M3U ========= */

app.post("/admin/import", async (req, res) => {
  try {
    const { m3u_url } = req.body;

    const response = await axios.get(m3u_url, { timeout: 20000 });
    const lines = response.data.split("\n");

    await pool.query("DELETE FROM channels");

    let name = "";
    let category = "";
    let count = 0;

    for (let line of lines) {
      if (line.startsWith("#EXTINF")) {
        name = line.split(",")[1] || "Sin nombre";
        const groupMatch = line.match(/group-title="(.*?)"/);
        category = groupMatch ? groupMatch[1] : "General";
      } 
      else if (line.startsWith("http")) {
        await pool.query(
          "INSERT INTO channels(name,url,category) VALUES($1,$2,$3)",
          [name, line.trim(), category]
        );
        count++;
      }
    }

    res.send(`Importados ${count} canales correctamente <br><a href="/">Volver</a>`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al importar M3U: " + error.message);
  }
});

/* ========= CREAR O REACTIVAR USUARIO ========= */

app.post("/admin/create-user", async (req, res) => {
  try {
    const { username, password, days, max_connections } = req.body;

    const hash = await bcrypt.hash(password, 10);

    let exp = null;
    if (days && days.trim() !== "") {
      exp = Math.floor(Date.now() / 1000) + (parseInt(days) * 86400);
    }

    const existing = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (existing.rows.length > 0) {
      // UPDATE si ya existe
      await pool.query(
        "UPDATE users SET password=$1, exp_date=$2, max_connections=$3 WHERE username=$4",
        [hash, exp, max_connections || 1, username]
      );
      res.send("Usuario reactivado / actualizado <br><a href='/'>Volver</a>");
    } else {
      // INSERT si no existe
      await pool.query(
        "INSERT INTO users(username,password,exp_date,max_connections) VALUES($1,$2,$3,$4)",
        [username, hash, exp, max_connections || 1]
      );
      res.send("Usuario creado <br><a href='/'>Volver</a>");
    }

  } catch (error) {
    console.error(error);
    res.status(500).send("Error al crear usuario");
  }
});

/* ========= VALIDAR USUARIO ========= */

async function validateUser(username, password) {
  const result = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (result.rows.length === 0) return null;

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return null;

  // Verificar expiración
  if (user.exp_date && user.exp_date < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return user;
}

/* ========= XTREAM API ========= */

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

/* ========= M3U PARA IPTV ========= */

app.get("/get.php", async (req, res) => {
  const { username, password, type } = req.query;
  const user = await validateUser(username, password);
  if (!user) return res.status(403).send("Denied");

  if (type === "m3u") {
    const channels = await pool.query("SELECT * FROM channels");

    let m3u = "#EXTM3U\n";
    channels.rows.forEach(ch => {
      m3u += `#EXTINF:-1 group-title="${ch.category}",${ch.name}\n`;
      m3u += `${ch.url}\n`;
    });

    res.setHeader("Content-Type", "application/x-mpegURL");
    res.send(m3u);
  }
});

/* ========= SERVER ========= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
