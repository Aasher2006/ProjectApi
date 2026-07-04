const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../Client')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Dashboard
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const [flights, passengers, revenue, aircraft] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_flights,
        COUNT(*) FILTER (WHERE status='Scheduled') AS scheduled,
        COUNT(*) FILTER (WHERE status='Cancelled') AS cancelled FROM flights`),
      pool.query(`SELECT COUNT(*) AS total_passengers FROM passengers`),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total_revenue FROM payments WHERE payment_status='Completed'`),
      pool.query(`SELECT COUNT(*) AS total_aircraft,
        COUNT(*) FILTER (WHERE status='Active') AS active FROM aircraft`)
    ]);

    res.json({
      flights: flights.rows[0],
      passengers: passengers.rows[0],
      revenue: revenue.rows[0],
      aircraft: aircraft.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/revenue-by-class', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cc.class_name, COALESCE(SUM(p.amount),0) AS total_revenue, COUNT(b.booking_id) AS bookings
      FROM cabin_classes cc
      LEFT JOIN bookings b ON cc.class_id = b.class_id AND b.booking_status != 'Cancelled'
      LEFT JOIN payments p ON b.booking_id = p.booking_id AND p.payment_status = 'Completed'
      GROUP BY cc.class_name ORDER BY total_revenue DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/bookings-by-status', async (req, res) => {
  try {
    const result = await pool.query(`SELECT booking_status, COUNT(*) AS count FROM bookings GROUP BY booking_status`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/flights-by-status', async (req, res) => {
  try {
    const result = await pool.query(`SELECT status, COUNT(*) AS count FROM flights GROUP BY status`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/top-routes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a1.airport_code || ' → ' || a2.airport_code AS route,
             COUNT(b.booking_id) AS bookings,
             COALESCE(SUM(p.amount),0) AS revenue
      FROM routes r
      JOIN airports a1 ON r.origin_airport_id = a1.airport_id
      JOIN airports a2 ON r.destination_airport_id = a2.airport_id
      JOIN flights f ON r.route_id = f.route_id
      JOIN bookings b ON f.flight_id = b.flight_id AND b.booking_status != 'Cancelled'
      LEFT JOIN payments p ON b.booking_id = p.booking_id AND p.payment_status = 'Completed'
      GROUP BY route ORDER BY bookings DESC LIMIT 8`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/monthly-revenue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT TO_CHAR(payment_date,'Mon YYYY') AS month,
             DATE_TRUNC('month',payment_date) AS month_date,
             SUM(amount) AS revenue, COUNT(*) AS transactions
      FROM payments WHERE payment_status='Completed'
      GROUP BY month_date, month ORDER BY month_date`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD
app.get('/api/flights', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT f.*, a1.airport_code AS origin_code, a2.airport_code AS dest_code,
             ac.registration_number, am.model_name
      FROM flights f
      JOIN routes r ON f.route_id = r.route_id
      JOIN airports a1 ON r.origin_airport_id = a1.airport_id
      JOIN airports a2 ON r.destination_airport_id = a2.airport_id
      JOIN aircraft ac ON f.aircraft_id = ac.aircraft_id
      JOIN aircraft_models am ON ac.model_id = am.model_id
      ORDER BY f.departure_time DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/flights', async (req, res) => {
  const { flight_number, route_id, aircraft_id, departure_time, arrival_time, gate, terminal } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO flights 
      (flight_number, route_id, aircraft_id, departure_time, arrival_time, gate, terminal)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [flight_number, route_id, aircraft_id, departure_time, arrival_time, gate, terminal]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/flights/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM luggage WHERE booking_id IN (SELECT booking_id FROM bookings WHERE flight_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM payments WHERE booking_id IN (SELECT booking_id FROM bookings WHERE flight_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM bookings WHERE flight_id=$1', [req.params.id]);
    await pool.query('DELETE FROM flight_seats WHERE flight_id=$1', [req.params.id]);
    await pool.query('DELETE FROM crew_assignments WHERE flight_id=$1', [req.params.id]);
    await pool.query('DELETE FROM flights WHERE flight_id=$1', [req.params.id]);

    res.json({ message: 'Flight deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/passengers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM passengers ORDER BY passenger_id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/passengers', async (req, res) => {
  const { first_name, last_name, email, phone, passport_number, nationality, date_of_birth, gender } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO passengers 
      (first_name, last_name, email, phone, passport_number, nationality, date_of_birth, gender)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [first_name, last_name, email, phone, passport_number, nationality, date_of_birth, gender]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/passengers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM luggage WHERE booking_id IN (SELECT booking_id FROM bookings WHERE passenger_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM payments WHERE booking_id IN (SELECT booking_id FROM bookings WHERE passenger_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM bookings WHERE passenger_id=$1', [req.params.id]);
    await pool.query('DELETE FROM passengers WHERE passenger_id=$1', [req.params.id]);

    res.json({ message: 'Passenger deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, p.first_name || ' ' || p.last_name AS passenger_name,
             f.flight_number, cc.class_name
      FROM bookings b
      JOIN passengers p ON b.passenger_id = p.passenger_id
      JOIN flights f ON b.flight_id = f.flight_id
      JOIN cabin_classes cc ON b.class_id = cc.class_id
      ORDER BY b.booking_date DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  const { passenger_id, flight_id, class_id, seat_number, ticket_price } = req.body;
  const ref = 'BK' + Date.now().toString().slice(-8);

  try {
    const result = await pool.query(
      `INSERT INTO bookings 
      (booking_reference, passenger_id, flight_id, class_id, seat_number, ticket_price)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ref, passenger_id, flight_id, class_id, seat_number, ticket_price]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM luggage WHERE booking_id = $1', [req.params.id]);
    await pool.query('DELETE FROM payments WHERE booking_id = $1', [req.params.id]);
    await pool.query('DELETE FROM bookings WHERE booking_id = $1', [req.params.id]);

    res.json({ message: 'Booking deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pay.*, b.booking_reference,
             p.first_name || ' ' || p.last_name AS passenger_name
      FROM payments pay
      JOIN bookings b ON pay.booking_id = b.booking_id
      JOIN passengers p ON b.passenger_id = p.passenger_id
      ORDER BY pay.payment_date DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/aircraft', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, am.model_name, am.manufacturer, am.total_seats
      FROM aircraft a 
      JOIN aircraft_models am ON a.model_id = am.model_id
      ORDER BY a.aircraft_id`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/airports', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, c.city_name, co.country_name 
      FROM airports a
      JOIN cities c ON a.city_id = c.city_id
      JOIN countries co ON c.country_id = co.country_id 
      ORDER BY a.airport_code`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/routes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, a1.airport_code AS origin, a2.airport_code AS destination,
             c1.city_name AS origin_city, c2.city_name AS dest_city
      FROM routes r
      JOIN airports a1 ON r.origin_airport_id = a1.airport_id
      JOIN airports a2 ON r.destination_airport_id = a2.airport_id
      JOIN cities c1 ON a1.city_id = c1.city_id
      JOIN cities c2 ON a2.city_id = c2.city_id 
      ORDER BY r.route_id`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cabin-classes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cabin_classes ORDER BY class_id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, a.airport_code
      FROM staff s
      LEFT JOIN airports a ON s.airport_id = a.airport_id
      ORDER BY s.staff_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/maintenance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT mr.*, ac.registration_number,
             st.first_name || ' ' || st.last_name AS technician
      FROM maintenance_records mr
      JOIN aircraft ac ON mr.aircraft_id = ac.aircraft_id
      LEFT JOIN staff st ON mr.technician_id = st.staff_id
      ORDER BY mr.record_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, database: 'disconnected', error: err.message });
  }
});
app.get('/api/analytics/staff-by-role', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT role, COUNT(*) AS count
      FROM staff
      GROUP BY role
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/payment-methods', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT payment_method, COUNT(*) AS count, SUM(amount) AS total
      FROM payments
      WHERE payment_status = 'Completed'
      GROUP BY payment_method
      ORDER BY total DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../Client/index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✈ Airline API running on port ${PORT}`);
});