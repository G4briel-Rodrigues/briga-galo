const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
let bullets = [];
let items = { hammer: null, gun: null, corn: null };

let gameInProgress = true;
let roundStartTime = Date.now();
let gunHasSpawned = false;
let lastCornSpawn = Date.now();

const MAP_W = 1200;
const MAP_H = 800;
const SPEED = 8;
const DASH_SPEED = 25;

// CONFIGURAÇÕES DE DANO E CURA (ATUALIZADAS)
const DMG_PECK = 0.9;
const DMG_HAMMER = 1.3;
const DMG_BULLET = 2; // <--- Dano do tiro agora é 2
const HEAL_CORN = 30;

function spawnItem(type) {
    const item = {
        x: Math.random() * (MAP_W - 200) + 100,
        y: Math.random() * (MAP_H - 200) + 100,
        type: type
    };
    items[type] = item;
    
    const msgs = { 
        hammer: '🔨 MARTELO NO CHÃO!', 
        gun: '🔫 ARMA LIBERADA! (Dano: 2)', 
        corn: '🌽 MILHO CAIU! +30 HP' 
    };
    io.emit('msg', msgs[type]);
    io.emit('update_items', items);
}

function resetRound() {
    gameInProgress = true;
    items = { hammer: null, gun: null, corn: null };
    bullets = [];
    roundStartTime = Date.now();
    lastCornSpawn = Date.now();
    gunHasSpawned = false;
    
    Object.keys(players).forEach(id => {
        players[id].hp = 100;
        players[id].hasHammer = false;
        players[id].hasGun = false;
        players[id].x = Math.random() * (MAP_W - 100) + 50;
        players[id].y = Math.random() * (MAP_H - 100) + 50;
    });

    io.emit('hide_winner');
    spawnItem('hammer');
    io.emit('update_state', players);
    io.emit('update_items', items);
}

// LOOP DE FÍSICA E TIMERS
setInterval(() => {
    if (!gameInProgress) return;
    const now = Date.now();

    // Spawn da Arma aos 50 segundos
    if (!gunHasSpawned && (now - roundStartTime >= 50000)) {
        spawnItem('gun');
        gunHasSpawned = true;
    }

    // Spawn do Milho a cada 60 segundos
    if (now - lastCornSpawn >= 60000) {
        spawnItem('corn');
        lastCornSpawn = now;
    }

    // Movimentação das Balas
    if (bullets.length > 0) {
        for (let i = bullets.length - 1; i >= 0; i--) {
            const b = bullets[i];
            b.x += Math.cos(b.angle) * 22;
            b.y += Math.sin(b.angle) * 22;

            if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) {
                bullets.splice(i, 1);
                continue;
            }

            Object.values(players).forEach(p => {
                if (p.id !== b.owner && p.hp > 0) {
                    if (Math.hypot(p.x - b.x, p.y - b.y) < 40) {
                        p.hp -= DMG_BULLET;
                        io.emit('player_hit', { id: p.id, dmg: DMG_BULLET, type: 'shot' });
                        bullets.splice(i, 1);
                        if (p.hp <= 0) handleDeath(p);
                    }
                }
            });
        }
        io.emit('update_bullets', bullets);
    }
}, 1000 / 30);

function handleDeath(p) {
    p.hp = 0;
    io.emit('msg', `☠️ ${p.name} VIROU CANJA!`);
    if (p.hasHammer) { p.hasHammer = false; items.hammer = { x: p.x, y: p.y }; }
    if (p.hasGun) { p.hasGun = false; items.gun = { x: p.x, y: p.y }; }
    
    const alive = Object.values(players).filter(pl => pl.hp > 0);
    if (Object.keys(players).length > 1 && alive.length <= 1) {
        gameInProgress = false;
        const winner = alive[0];
        if(winner) winner.wins++;
        io.emit('show_winner', winner ? winner.name : "Ninguém");
        setTimeout(resetRound, 5000);
    }
    io.emit('update_state', players);
}

io.on('connection', (socket) => {
    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id, name: data.name, color: data.color,
            x: 100, y: 100, hp: 100, wins: 0,
            hasHammer: false, hasGun: false, direction: 1, lastDash: 0
        };
        socket.emit('login_success', { id: socket.id, width: MAP_W, height: MAP_H });
        io.emit('update_state', players);
        io.emit('update_items', items);
    });

    socket.on('move', (dir) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0 || !gameInProgress) return;
        if (dir === 'w') p.y -= SPEED; if (dir === 's') p.y += SPEED;
        if (dir === 'a') { p.x -= SPEED; p.direction = -1; }
        if (dir === 'd') { p.x += SPEED; p.direction = 1; }
        io.emit('update_state', players);
    });

    socket.on('click_action', (m) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0 || !gameInProgress) return;

        // Tentar pegar itens
        if (items.hammer && Math.hypot(p.x - items.hammer.x, p.y - items.hammer.y) < 70) {
            items.hammer = null; p.hasHammer = true; p.hasGun = false;
        } else if (items.gun && Math.hypot(p.x - items.gun.x, p.y - items.gun.y) < 70) {
            items.gun = null; p.hasGun = true; p.hasHammer = false;
        } else if (items.corn && Math.hypot(p.x - items.corn.x, p.y - items.corn.y) < 70) {
            items.corn = null; p.hp = Math.min(100, p.hp + HEAL_CORN);
        } else {
            // Atacar ou Atirar
            if (p.hasGun) {
                const angle = Math.atan2(m.y - p.y, m.x - p.x);
                bullets.push({ x: p.x + 30, y: p.y + 30, angle, owner: socket.id });
                io.emit('action_anim', { id: socket.id, type: 'shoot' });
            } else {
                io.emit('action_anim', { id: socket.id, type: 'attack' });
                Object.values(players).forEach(target => {
                    if (target.id !== p.id && Math.hypot(p.x - target.x, p.y - target.y) < 100) {
                        const dmg = p.hasHammer ? DMG_HAMMER : DMG_PECK;
                        target.hp -= dmg;
                        if (target.hp <= 0) handleDeath(target);
                    }
                });
            }
        }
        io.emit('update_items', items);
        io.emit('update_state', players);
    });

    socket.on('disconnect', () => { delete players[socket.id]; io.emit('update_state', players); });
});

server.listen(8080);
