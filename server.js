const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- ESTADO DO JOGO ---
let players = {};
let items = [];
let gameStarted = false;

// Timers para controle
let hammerInterval = null;
let cornInterval = null;

const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const PLAYER_SIZE = 60;

io.on('connection', (socket) => {
    console.log(`Novo galo conectado: ${socket.id}`);

    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name.substring(0, 10),
            color: data.color,
            x: Math.random() * (MAP_WIDTH - 100) + 50,
            y: Math.random() * (MAP_HEIGHT - 100) + 50,
            hp: 100,
            direction: 1,
            wins: 0,
            hasHammer: false,
            dead: false
        };

        socket.emit('login_success', { id: socket.id, width: MAP_WIDTH, height: MAP_HEIGHT });
        io.emit('msg', `${players[socket.id].name} ENTROU NA RINHA!`);
        updateLeaderboard();

        if (Object.keys(players).length === 1 && !gameStarted) {
            startGameLoop();
        }
    });

    socket.on('move', (dir) => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        const speed = 7;
        if (dir === 'w') p.y = Math.max(0, p.y - speed);
        if (dir === 's') p.y = Math.min(MAP_HEIGHT - PLAYER_SIZE, p.y + speed);
        if (dir === 'a') { p.x = Math.max(0, p.x - speed); p.direction = -1; }
        if (dir === 'd') { p.x = Math.min(MAP_WIDTH - PLAYER_SIZE, p.x + speed); p.direction = 1; }
    });

    socket.on('dash', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        
        const dashDist = 80;
        p.x = Math.max(0, Math.min(MAP_WIDTH - PLAYER_SIZE, p.x + (dashDist * p.direction)));
        io.emit('action_anim', { id: p.id, type: 'dash' });
    });

    socket.on('click_action', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        io.emit('action_anim', { id: p.id, type: 'attack' });
        
        const range = p.hasHammer ? 100 : 50;
        
        // --- ALTERAÇÃO AQUI: Dano modificado ---
        // Martelo: 1 de dano | Bicada normal: 0.8 de dano
        const damage = p.hasHammer ? 1 : 0.8;

        Object.values(players).forEach(target => {
            if (target.id !== p.id && !target.dead) {
                const dist = Math.hypot(target.x - p.x, target.y - p.y);
                if (dist < range) {
                    takeDamage(target, damage, p.id);
                }
            }
        });
    });

    socket.on('taunt', (index) => {
        const msgs = ["PÓ PÓ PÓ!", "VEM TRANQUILO!", "GALO DOIDO!"];
        if (players[socket.id]) {
            io.emit('msg_bubble', { id: socket.id, text: msgs[index] || "CÓRÓCÓ!" });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        if (Object.keys(players).length === 0) {
            stopGameLoop();
        }
        io.emit('update_state', players);
    });
});

// --- LÓGICA DO JOGO ---

function startGameLoop() {
    if (gameStarted) return;
    gameStarted = true;
    console.log("Jogo iniciado! Martelo e Milho ativados (40s).");

    if (hammerInterval) clearInterval(hammerInterval);
    if (cornInterval) clearInterval(cornInterval);

    // --- ALTERAÇÃO AQUI: Timers configurados para 40000ms (40s) ---
    hammerInterval = setInterval(() => {
        spawnItem('hammer');
    }, 40000);

    cornInterval = setInterval(() => {
        spawnItem('corn');
    }, 40000);
}

function stopGameLoop() {
    gameStarted = false;
    if (hammerInterval) clearInterval(hammerInterval);
    if (cornInterval) clearInterval(cornInterval);
    items = [];
    console.log("Jogo pausado.");
}

function spawnItem(type) {
    const item = {
        id: Math.random().toString(36).substr(2, 9),
        type: type,
        x: Math.random() * (MAP_WIDTH - 50),
        y: Math.random() * (MAP_HEIGHT - 50)
    };
    items.push(item);
    
    if (type === 'hammer') io.emit('hammer_spawn', item);
    if (type === 'corn') io.emit('corn_spawn', item);
}

function takeDamage(target, amount, attackerId) {
    target.hp -= amount;
    io.emit('player_hit', { id: target.id });

    if (target.hp <= 0) {
        target.hp = 0;
        target.dead = true;
        target.hasHammer = false;
        io.emit('msg', `${target.name} VIROU CANJA!`);
        
        if (attackerId && players[attackerId]) {
            players[attackerId].wins++;
            updateLeaderboard();
            io.emit('show_winner', players[attackerId].name);
            
            setTimeout(() => {
                resetRound(); 
                io.emit('hide_winner');
            }, 5000);
        }
    }
}

function resetRound() {
    items = [];
    io.emit('clear_items');
    
    Object.values(players).forEach(p => {
        p.hp = 100;
        p.dead = false;
        p.hasHammer = false;
        p.x = Math.random() * (MAP_WIDTH - 100);
        p.y = Math.random() * (MAP_HEIGHT - 100);
    });

    if (hammerInterval) clearInterval(hammerInterval);
    if (cornInterval) clearInterval(cornInterval);
    
    // --- ALTERAÇÃO AQUI: Timers resetados para 40s também na nova rodada ---
    hammerInterval = setInterval(() => spawnItem('hammer'), 40000);
    cornInterval = setInterval(() => spawnItem('corn'), 40000);
}

function updateLeaderboard() {
    const sorted = Object.values(players).sort((a, b) => b.wins - a.wins).slice(0, 5);
    io.emit('update_leaderboard', sorted);
}

// LOOP PRINCIPAL (60 FPS)
setInterval(() => {
    if (!gameStarted) return;

    // Colisão Player vs Itens
    Object.values(players).forEach(p => {
        if(p.dead) return;
        
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const dist = Math.hypot(p.x - item.x, p.y - item.y);

            if (dist < 50) {
                // Pegou item
                if (item.type === 'hammer') {
                    p.hasHammer = true;
                    io.emit('msg_bubble', { id: p.id, text: "MARRETADA!" });
                } else if (item.type === 'corn') {
                    // --- ALTERAÇÃO AQUI: Cura aumentada para 35 ---
                    p.hp = Math.min(100, p.hp + 35); 
                    io.emit('msg_bubble', { id: p.id, text: "DELÍCIA!" });
                }
                
                io.emit('item_update', { id: item.id, status: 'picked' });
                items.splice(i, 1);
            }
        }
    });

    io.emit('update_state', players);

}, 1000 / 60);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`UFC GALO 3.3 - AJUSTE DE DANO - PORTA: ${PORT}`);
});
