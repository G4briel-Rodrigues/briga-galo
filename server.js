const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CONFIGURAÇÕES ---
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const PLAYER_SIZE = 60;

// Danos e Curas
const DMG_PECK = 0.8;
const DMG_HAMMER = 1.5;
const DMG_FENCE = 0.5;
const HEAL_CORN = 15.0;

let players = {};
let items = [];
let gameStarted = false;

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name || "Galo",
            color: data.color || 'branco',
            x: Math.random() * (MAP_WIDTH - 100) + 50,
            y: Math.random() * (MAP_HEIGHT - 100) + 50,
            hp: 100,
            direction: 1, 
            wins: 0,
            hasHammer: false,
            dead: false,
            speed: 7,
            lastAttack: 0
        };
        socket.emit('login_success', { id: socket.id, width: MAP_WIDTH, height: MAP_HEIGHT });
        
        if (Object.keys(players).length >= 2 && !gameStarted) {
            startGame();
        }
    });

    socket.on('move', (dir) => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        if (dir === 'w') p.y -= p.speed;
        if (dir === 's') p.y += p.speed;
        if (dir === 'a') { p.x -= p.speed; p.direction = -1; }
        if (dir === 'd') { p.x += p.speed; p.direction = 1; }
        p.x = Math.max(0, Math.min(MAP_WIDTH - PLAYER_SIZE, p.x));
        p.y = Math.max(0, Math.min(MAP_HEIGHT - PLAYER_SIZE, p.y));
    });

    socket.on('click_action', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        const now = Date.now();
        if (now - p.lastAttack < 50) return; // Velocidade do clique
        p.lastAttack = now;

        io.emit('action_anim', { id: p.id });

        if (!gameStarted) return;

        const range = p.hasHammer ? 110 : 70;
        let damage = p.hasHammer ? DMG_HAMMER : DMG_PECK;
        
        Object.values(players).forEach(target => {
            if (target.id !== p.id && !target.dead) {
                const dist = Math.hypot(target.x - p.x, target.y - p.y);
                if (dist < range) {
                    target.hp -= damage;
                    io.emit('player_hit', { id: target.id });
                    if (target.hp <= 0) {
                        target.dead = true;
                        p.wins++;
                        updateLB();
                    }
                }
            }
        });
    });

    socket.on('disconnect', () => { delete players[socket.id]; updateLB(); });
});

function spawnItem(type) {
    const item = { id: Math.random().toString(36).substr(2,9), type, x: Math.random()*(MAP_WIDTH-50), y: Math.random()*(MAP_HEIGHT-50) };
    items.push(item);
    io.emit(type === 'hammer' ? 'hammer_spawn' : 'corn_spawn', item);
}

function startGame() {
    gameStarted = true;
    io.emit('msg', "RINHA INICIADA!");
    setInterval(() => { if(items.filter(i=>i.type==='hammer').length < 3) spawnItem('hammer') }, 20000);
    setInterval(() => { if(items.filter(i=>i.type==='corn').length < 5) spawnItem('corn') }, 15000);
}

function updateLB() {
    const sorted = Object.values(players).sort((a,b) => b.wins - a.wins).slice(0,5);
    io.emit('update_leaderboard', sorted);
}

setInterval(() => {
    Object.values(players).forEach(p => {
        if(p.dead) return;
        // Cerca
        if (p.x <= 5 || p.x >= MAP_WIDTH - PLAYER_SIZE - 5 || p.y <= 5 || p.y >= MAP_HEIGHT - PLAYER_SIZE - 5) {
            p.hp -= DMG_FENCE;
        }
        // Itens
        items.forEach((it, idx) => {
            if (Math.hypot(p.x - it.x, p.y - it.y) < 40) {
                if (it.type === 'hammer') p.hasHammer = true;
                if (it.type === 'corn') p.hp = Math.min(100, p.hp + HEAL_CORN);
                io.emit('item_update', { id: it.id, status: 'picked' });
                items.splice(idx, 1);
            }
        });
    });
    io.emit('update_state', players);
}, 1000/60);

server.listen(8080, () => console.log("Servidor Online"));
