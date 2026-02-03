const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CONFIGURAÇÕES ---
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;
const PLAYER_SIZE = 70;
const MAX_PLAYERS = 7; // Limite de 7 jogadores

// Danos e Curas
const HP_MAX = 100;
const DMG_PECK = 0.8;
const DMG_HAMMER = 1.2;
const HEAL_CORN = 15.0;

// Configuração de Drops
const MAX_CORNS = 8;
const MAX_HAMMERS = 5;
const CORN_INTERVAL_MS = 30000;
const HAMMER_INTERVAL_MS = 40000;

let players = {};
let items = [];
let gameLoopInterval = null;
let cornInterval = null;
let hammerInterval = null;
let gameOverPending = false;

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    
    socket.on('join_game', (data) => {
        // Verifica se a sala está cheia
        if (Object.keys(players).length >= MAX_PLAYERS) {
            socket.emit('login_error', 'A RINHA ESTÁ CHEIA! (Máx 7 Galos)');
            return;
        }

        let cleanName = (data.name || "Galo").trim().substring(0, 15);
        
        players[socket.id] = {
            id: socket.id,
            name: cleanName,
            color: data.color || 'branco',
            x: Math.random() * (MAP_WIDTH - 100) + 50,
            y: Math.random() * (MAP_HEIGHT - 100) + 50,
            hp: HP_MAX,
            direction: 1, 
            hasHammer: false,
            dead: false,
            speed: 8,
            lastAttack: 0
        };
        
        socket.emit('login_success', { id: socket.id, width: MAP_WIDTH, height: MAP_HEIGHT });
        
        // Inicia o jogo se for o primeiro
        if (!gameLoopInterval) startGameLoop();
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
        if (now - p.lastAttack < 100) return;
        p.lastAttack = now;

        io.emit('action_anim', { id: p.id });

        const range = p.hasHammer ? 120 : 80;
        let damage = p.hasHammer ? DMG_HAMMER : DMG_PECK;
        
        Object.values(players).forEach(target => {
            if (target.id !== p.id && !target.dead) {
                const dist = Math.hypot((target.x + PLAYER_SIZE/2) - (p.x + PLAYER_SIZE/2), (target.y + PLAYER_SIZE/2) - (p.y + PLAYER_SIZE/2));
                
                if (dist < range) {
                    target.hp -= damage;
                    io.emit('blood_effect', { x: target.x, y: target.y });

                    if (target.hp <= 0) {
                        target.hp = 0;
                        target.dead = true;
                        checkWinCondition();
                    }
                }
            }
        });
    });

    socket.on('disconnect', () => { 
        delete players[socket.id]; 
        checkWinCondition(); 
        if (Object.keys(players).length === 0) stopGameLoop();
    });
});

function spawnItem(type) {
    const item = { 
        id: Math.random().toString(36).substr(2,9), 
        type, 
        x: Math.random()*(MAP_WIDTH-50), 
        y: Math.random()*(MAP_HEIGHT-50) 
    };
    items.push(item);
    io.emit(type === 'hammer' ? 'hammer_spawn' : 'corn_spawn', item);
}

function startGameLoop() {
    if (gameLoopInterval) return;
    console.log("Servidor de Jogo Iniciado");

    cornInterval = setInterval(() => {
        const count = items.filter(i => i.type === 'corn').length;
        if (count < MAX_CORNS) spawnItem('corn');
    }, CORN_INTERVAL_MS);

    hammerInterval = setInterval(() => {
        const count = items.filter(i => i.type === 'hammer').length;
        if (count < MAX_HAMMERS) spawnItem('hammer');
    }, HAMMER_INTERVAL_MS);

    gameLoopInterval = setInterval(() => {
        Object.values(players).forEach(p => {
            if(p.dead) return;

            // Loop reverso para poder remover itens sem bugar o array
            for (let i = items.length - 1; i >= 0; i--) {
                const it = items[i];
                const dist = Math.hypot((p.x + PLAYER_SIZE/2) - it.x, (p.y + PLAYER_SIZE/2) - it.y);
                
                if (dist < 60) {
                    let picked = false;

                    if (it.type === 'hammer') {
                        // Só pega se NÃO tiver martelo ainda
                        if (!p.hasHammer) {
                            p.hasHammer = true;
                            picked = true;
                        }
                    } else if (it.type === 'corn') {
                        p.hp = Math.min(HP_MAX, p.hp + HEAL_CORN);
                        picked = true;
                    }

                    if (picked) {
                        io.emit('item_update', { id: it.id, status: 'picked' });
                        items.splice(i, 1);
                    }
                }
            }
        });
        io.emit('update_state', players);
    }, 1000/60);
}

function stopGameLoop() {
    clearInterval(gameLoopInterval);
    clearInterval(cornInterval);
    clearInterval(hammerInterval);
    gameLoopInterval = null;
    items = [];
    console.log("Servidor Pausado");
}

function checkWinCondition() {
    if (gameOverPending) return;

    const alive = Object.values(players).filter(p => !p.dead);
    const total = Object.keys(players).length;

    if (total > 1 && alive.length === 1) {
        gameOverPending = true;
        const winner = alive[0];
        io.emit('game_over', { winner: winner.name });

        setTimeout(() => {
            Object.values(players).forEach(p => {
                p.hp = HP_MAX;
                p.dead = false;
                p.hasHammer = false;
                p.x = Math.random() * (MAP_WIDTH - 100) + 50;
                p.y = Math.random() * (MAP_HEIGHT - 100) + 50;
            });
            items = []; 
            gameOverPending = false;
            io.emit('msg', "NOVA RODADA!");
        }, 5000);
    }
}

server.listen(8080, () => console.log("Servidor Online na porta 8080"));
