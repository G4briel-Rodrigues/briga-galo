const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve os arquivos estáticos (index.html, etc.) da pasta atual
app.use(express.static(__dirname));

let players = {};
let hammer = null; 
let hammerHolderId = null;
let gameInProgress = true;

const MAP_W = 1200;
const MAP_H = 800;
const SPEED = 8;
const DASH_SPEED = 25;
const DASH_COOLDOWN = 3000;
const HAMMER_RESPAWN_TIME = 120 * 1000; 

function spawnHammer() {
    hammer = {
        x: MAP_W / 2 + (Math.random() * 400 - 200),
        y: MAP_H / 2 + (Math.random() * 300 - 150)
    };
    hammerHolderId = null;
    io.emit('hammer_spawn', hammer);
    io.emit('msg', '🔨 O MARTELO CAIU NO TERREIRO!');
}

function resetRound() {
    gameInProgress = true;
    hammer = null;
    hammerHolderId = null;
    
    Object.keys(players).forEach(id => {
        players[id].hp = 100;
        players[id].hasHammer = false;
        players[id].x = Math.random() * (MAP_W - 100) + 50;
        players[id].y = Math.random() * (MAP_H - 100) + 50;
        players[id].lastDash = 0;
    });

    io.emit('hide_winner');
    spawnHammer();
    io.emit('update_state', players);
    io.emit('msg', '🔔 NOVA RODADA! BATAM AS ASAS!');
}

function checkWinCondition() {
    if (!gameInProgress) return;
    const alivePlayers = Object.values(players).filter(p => p.hp > 0);
    const totalPlayers = Object.keys(players).length;

    if (totalPlayers > 1 && alivePlayers.length <= 1) {
        gameInProgress = false;
        let winnerName = "NINGUÉM";
        if (alivePlayers.length === 1) {
            const winner = alivePlayers[0];
            winnerName = winner.name;
            winner.wins += 1;
        }
        io.emit('update_leaderboard', getLeaderboard());
        io.emit('show_winner', winnerName);
        setTimeout(resetRound, 5000);
    }
}

function getLeaderboard() {
    return Object.values(players)
        .sort((a, b) => b.wins - a.wins)
        .slice(0, 5)
        .map(p => ({ name: p.name, wins: p.wins }));
}

setInterval(() => {
    if (!hammer && !hammerHolderId && gameInProgress) spawnHammer();
}, HAMMER_RESPAWN_TIME);

setTimeout(spawnHammer, 5000); 

io.on('connection', (socket) => {
    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: (data.name || "Galo").substring(0, 10),
            color: data.color,
            x: Math.random() * (MAP_W - 100) + 50,
            y: Math.random() * (MAP_H - 100) + 50,
            hp: 100,
            wins: 0,
            hasHammer: false,
            direction: 1,
            lastDash: 0
        };
        socket.emit('login_success', { id: socket.id, width: MAP_W, height: MAP_H });
        io.emit('update_state', players);
        io.emit('update_leaderboard', getLeaderboard());
        if(hammer) socket.emit('hammer_spawn', hammer);
    });

    socket.on('move', (dir) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0 || !gameInProgress) return;
        if (dir === 'w') p.y -= SPEED;
        if (dir === 's') p.y += SPEED;
        if (dir === 'a') { p.x -= SPEED; p.direction = -1; }
        if (dir === 'd') { p.x += SPEED; p.direction = 1; }
        p.x = Math.max(0, Math.min(MAP_W - 80, p.x));
        p.y = Math.max(0, Math.min(MAP_H - 80, p.y));
        io.emit('update_state', players);
    });

    socket.on('dash', () => {
        const p = players[socket.id];
        const now = Date.now();
        if (!p || p.hp <= 0 || !gameInProgress) return;
        if (now - p.lastDash > DASH_COOLDOWN) {
            p.lastDash = now;
            p.x += (DASH_SPEED * 5) * p.direction; 
            io.emit('msg_bubble', { id: socket.id, text: "💨 DASH!", color: "#fff" });
            io.emit('update_state', players);
        }
    });

    socket.on('taunt', (msgIndex) => {
        const p = players[socket.id];
        if (!p || p.hp <= 0) return;
        const taunts = ["Pó pó pó!", "Vem tranquilo!", "Frango!", "Respeita o Galo!"];
        io.emit('msg_bubble', { id: socket.id, text: taunts[msgIndex] || "Cocoricó!", color: "yellow" });
    });

    socket.on('click_action', () => {
        const p = players[socket.id];
        if(!p || p.hp <= 0 || !gameInProgress) return;

        let actionHappened = false;

        if (hammer && !hammerHolderId) {
            if (Math.hypot(p.x - hammer.x, p.y - hammer.y) < 80) {
                hammer = null;
                hammerHolderId = socket.id;
                p.hasHammer = true;
                io.emit('hammer_picked');
                io.emit('msg', `⚡ ${p.name} PEGOU O MARTELO!`);
                actionHappened = true;
            }
        }

        if (!actionHappened) {
            io.emit('action_anim', { id: socket.id, type: 'attack' });
            Object.keys(players).forEach(targetId => {
                if (targetId === socket.id) return;
                const target = players[targetId];
                if (target.hp <= 0) return;

                if (Math.hypot(p.x - target.x, p.y - target.y) < 110) {
                    const damage = p.hasHammer ? 1.5 : 0.5; 
                    target.hp -= damage;

                    const angle = Math.atan2(target.y - p.y, target.x - p.x);
                    const pushForce = p.hasHammer ? 120 : 40;
                    target.x += Math.cos(angle) * pushForce;
                    target.y += Math.sin(angle) * pushForce;
                    
                    target.x = Math.max(0, Math.min(MAP_W - 80, target.x));
                    target.y = Math.max(0, Math.min(MAP_H - 80, target.y));

                    io.emit('player_hit', { id: targetId, dmg: damage });

                    if (target.hp <= 0) {
                        target.hp = 0;
                        io.emit('msg', `☠️ ${target.name} FOI DEPENADO!`);
                        if (target.hasHammer) {
                            target.hasHammer = false; hammerHolderId = null;
                            hammer = { x: target.x, y: target.y };
                            io.emit('hammer_spawn', hammer);
                        }
                        checkWinCondition();
                    }
                }
            });
        }
        io.emit('update_state', players);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        if (socket.id === hammerHolderId) { hammerHolderId = null; spawnHammer(); }
        io.emit('update_state', players);
        io.emit('update_leaderboard', getLeaderboard());
        checkWinCondition();
    });
});

// CONFIGURAÇÃO DE PORTA DINÂMICA PARA O RENDER
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`UFC GALO RODANDO NA PORTA: ${PORT}`));