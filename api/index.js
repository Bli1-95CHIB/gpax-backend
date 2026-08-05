const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Connect to Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Grade mapping
function gradeToPoints(grade) {
    const map = {
        'A': 5.0, 'B': 4.0, 'C': 3.0,
        'D': 2.0, 'E': 1.0, 'F': 0.0
    };
    return map[grade] || 0;
}

// ---------- SIGNUP ----------
app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
            [username, hashedPassword]
        );
        res.json({ success: true, userId: result.rows[0].id });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ---------- LOGIN ----------
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({
            success: true,
            userId: user.id,
            username: user.username,
            targetGpa: user.target_gpa,
            theme: user.theme_pref
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- UPDATE TARGET GPA ----------
app.put('/api/users/target', async (req, res) => {
    const { userId, targetGpa } = req.body;
    if (!userId || targetGpa === undefined) {
        return res.status(400).json({ error: 'User ID and target GPA required' });
    }
    if (targetGpa < 0 || targetGpa > 5) {
        return res.status(400).json({ error: 'Target GPA must be between 0 and 5' });
    }
    try {
        await pool.query('UPDATE users SET target_gpa = $1 WHERE id = $2', [targetGpa, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- UPDATE THEME ----------
app.put('/api/users/theme', async (req, res) => {
    const { userId, theme } = req.body;
    if (!userId || !theme) {
        return res.status(400).json({ error: 'User ID and theme required' });
    }
    if (!['dark', 'light'].includes(theme)) {
        return res.status(400).json({ error: 'Theme must be dark or light' });
    }
    try {
        await pool.query('UPDATE users SET theme_pref = $1 WHERE id = $2', [theme, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- GET ALL COURSES ----------
app.get('/api/courses/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const result = await pool.query(
            'SELECT * FROM courses WHERE user_id = $1 ORDER BY level DESC, semester DESC, created_at DESC',
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- ADD COURSE ----------
app.post('/api/courses', async (req, res) => {
    const { userId, courseName, credits, grade, level, semester } = req.body;
    if (!userId || !courseName || !credits || !grade || !level || !semester) {
        return res.status(400).json({ error: 'All fields required' });
    }
    const validGrades = ['A', 'B', 'C', 'D', 'E', 'F'];
    if (!validGrades.includes(grade)) {
        return res.status(400).json({ error: 'Invalid grade' });
    }
    if (credits <= 0) {
        return res.status(400).json({ error: 'Credits must be greater than 0' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO courses (user_id, course_name, credits, grade, level, semester)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [userId, courseName, credits, grade, level, semester]
        );
        res.json({ success: true, courseId: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- EDIT COURSE ----------
app.put('/api/courses/:id', async (req, res) => {
    const courseId = req.params.id;
    const { courseName, credits, grade, level, semester } = req.body;
    if (!courseName || !credits || !grade || !level || !semester) {
        return res.status(400).json({ error: 'All fields required' });
    }
    try {
        await pool.query(
            `UPDATE courses 
             SET course_name = $1, credits = $2, grade = $3, level = $4, semester = $5
             WHERE id = $6`,
            [courseName, credits, grade, level, semester, courseId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- DELETE COURSE ----------
app.delete('/api/courses/:id', async (req, res) => {
    const courseId = req.params.id;
    try {
        await pool.query('DELETE FROM courses WHERE id = $1', [courseId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- GET TRANSCRIPT ----------
app.get('/api/transcript/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const coursesResult = await pool.query(
            'SELECT * FROM courses WHERE user_id = $1 ORDER BY level DESC, semester DESC, created_at DESC',
            [userId]
        );
        const courses = coursesResult.rows;

        const userResult = await pool.query('SELECT target_gpa FROM users WHERE id = $1', [userId]);
        const targetGpa = userResult.rows[0]?.target_gpa || 5.0;

        let totalCredits = 0;
        let weightedSum = 0;
        courses.forEach(c => {
            const points = gradeToPoints(c.grade);
            weightedSum += points * c.credits;
            totalCredits += c.credits;
        });
        const gpa = totalCredits > 0 ? weightedSum / totalCredits : 0;

        const grouped = {};
        courses.forEach(c => {
            const key = `${c.level}L ${c.semester} Semester`;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(c);
        });

        const semesterData = {};
        Object.keys(grouped).forEach(key => {
            const semCourses = grouped[key];
            let semCredits = 0;
            let semWeighted = 0;
            semCourses.forEach(c => {
                const points = gradeToPoints(c.grade);
                semWeighted += points * c.credits;
                semCredits += c.credits;
            });
            semesterData[key] = {
                courses: semCourses,
                gpa: semCredits > 0 ? Math.round((semWeighted / semCredits) * 100) / 100 : 0,
                totalCredits: semCredits
            };
        });

        const redFlags = courses.filter(c => gradeToPoints(c.grade) < targetGpa);

        res.json({
            courses,
            grouped: semesterData,
            overall: {
                gpa: Math.round(gpa * 100) / 100,
                totalCredits,
                weightedSum,
                courseCount: courses.length
            },
            targetGpa,
            redFlags: redFlags.length,
            redFlagCourses: redFlags
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- WHAT-IF SIMULATOR ----------
app.post('/api/simulate', async (req, res) => {
    const { userId, credits, grade } = req.body;
    if (!userId || !credits || !grade) {
        return res.status(400).json({ error: 'All fields required' });
    }
    try {
        const result = await pool.query('SELECT credits, grade FROM courses WHERE user_id = $1', [userId]);
        const courses = result.rows;
        let totalCredits = 0;
        let weightedSum = 0;
        courses.forEach(c => {
            const points = gradeToPoints(c.grade);
            weightedSum += points * c.credits;
            totalCredits += c.credits;
        });
        const currentGpa = totalCredits > 0 ? weightedSum / totalCredits : 0;
        const points = gradeToPoints(grade);
        const newWeighted = weightedSum + (points * credits);
        const newCredits = totalCredits + credits;
        const newGpa = newCredits > 0 ? newWeighted / newCredits : 0;
        const difference = newGpa - currentGpa;

        res.json({
            currentGpa: Math.round(currentGpa * 100) / 100,
            newGpa: Math.round(newGpa * 100) / 100,
            difference: Math.round(difference * 100) / 100,
            willLower: difference < 0,
            willRaise: difference > 0,
            message: difference > 0 ? `📈 GPA would increase by ${Math.round(difference * 100) / 100}` :
                     difference < 0 ? `📉 GPA would decrease by ${Math.round(Math.abs(difference) * 100) / 100}` :
                     '➖ GPA would stay the same'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;