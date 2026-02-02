const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};

// Itens do jogo
let hammer = null; 
let hammerHolderId = null;

let gun = null;
let gunHolderId = null;

let corn = null;

let gameInProgress = true;

const MAP_W = 1200;
const MAP_H = 800;
const SPEED = 8;
const DASH_SPEED = 25;
const DASH_COOLDOWN = 3000;

// Tempos de Respawn
const HAMMER_RESPAWN_TIME = 40 * 1000; // 40 segundos
const GUN_RESPAWN_TIME = 60 * 1000;    // 1 minuto
const CORN_RESPAWN_TIME = 75 * 1000;   // 1 minuto e 15 segundos

// --- FUNÇÕES DE SPAWN ---

function getRandomPos() {
    return {
        x: MAP_W / 2 + (Math.random() * 600 - 300),
        y: MAP_H / 2 + (Math.random() * 400 - 200)
    };
}

function spawnHammer() {
    hammer = getRandomPos();
    hammerHolderId = null;
    io.emit('hammer_spawn', hammer);
    io.emit('msg', '🔨 O MARTELO CAIU NO TERREIRO!');
}

function spawnGun() {
    gun = getRandomPos();
    gunHolderId = null;
    io.emit('gun_spawn', gun);
    io.emit('msg', '🔫 UMA ARMA APARECEU! O BICHO VAI PEGAR!');
}

function spawnCorn() {
    corn = getRandomPos();
    io.emit('corn_spawn', corn);
    io.emit('msg', '🌽 MILHO DOURADO! (CURA +30 HP)');
}

function resetRound() {
    gameInProgress = true;
    hammer = null; hammerHolderId = null;
    gun = null; gunHolderId = null;
    corn = null;
    
    Object.keys(players).forEach(id => {
        players[id].hp = 100;
        players[id].hasHammer = false;
        players[id].hasGun = false;
        players[id].x = Math.random() * (MAP_W - 100) + 50;
        players[id].y = Math.random() * (MAP_H - 100) + 50;
        players[id].lastDash = 0;
    });

    io.emit('hide_winner');
    io.emit('clear_items'); // Limpa itens visuais antigos
    
    // Agendar spawns iniciais da rodada
    setTimeout(spawnHammer, 5000); 
    setTimeout(spawnGun, 15000);   
    setTimeout(spawnCorn, 10000);  

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

// --- TIMERS GLOBAIS ---
setInterval(() => {
    if (!hammer && !hammerHolderId && gameInProgress) spawnHammer();
}, HAMMER_RESPAWN_TIME);

setInterval(() => {
    if (!gun && !gunHolderId && gameInProgress) spawnGun();
}, GUN_RESPAWN_TIME);

setInterval(() => {
    if (!corn && gameInProgress) spawnCorn();
}, CORN_RESPAWN_TIME);

// Spawn inicial ao ligar servidor
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
            hasGun: false,
            direction: 1,
            lastDash: 0
        };
        socket.emit('login_success', { id: socket.id, width: MAP_W, height: MAP_H });
        
        // Enviar estado atual dos itens para quem entrou agora
        if(hammer) socket.emit('hammer_spawn', hammer);
        if(gun) socket.emit('gun_spawn', gun);
        if(corn) socket.emit('corn_spawn', corn);

        io.emit('update_state', players);
        io.emit('update_leaderboard', getLeaderboard());
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

        // 1. Tentar pegar Martelo
        if (hammer && !hammerHolderId) {
            if (Math.hypot(p.x - hammer.x, p.y - hammer.y) < 80) {
                hammer = null;
                hammerHolderId = socket.id;
                p.hasHammer = true;
                p.hasGun = false; // Solta a arma se tiver
                io.emit('item_update', { type: 'hammer', status: 'picked' });
                io.emit('msg', `⚡ ${p.name} PEGOU O MARTELO!`);
                actionHappened = true;
            }
        }

        // 2. Tentar pegar Arma
        if (!actionHappened && gun && !gunHolderId) {
            if (Math.hypot(p.x - gun.x, p.y - gun.y) < 80) {
                gun = null;
                gunHolderId = socket.id;
                p.hasGun = true;
                p.hasHammer = false; // Solta o martelo se tiver
                io.emit('item_update', { type: 'gun', status: 'picked' });
                io.emit('msg', `🔫 ${p.name} PEGOU O FERRO!`);
                actionHappened = true;
            }
        }

        // 3. Tentar pegar Milho
        if (!actionHappened && corn) {
            if (Math.hypot(p.x - corn.x, p.y - corn.y) < 80) {
                corn = null;
                p.hp = Math.min(100, p.hp + 30); // Recupera 30 HP
                io.emit('item_update', { type: 'corn', status: 'picked' });
                io.emit('msg', `🌽 ${p.name} COMEU MILHO E CUROU!`);
                actionHappened = true;
            }
        }

        // 4. Se não pegou nada, ataca
        if (!actionHappened) {
            let animType = 'attack';
            if(p.hasGun) animType = 'shoot'; 

            io.emit('action_anim', { id: socket.id, type: animType });
            
            Object.keys(players).forEach(targetId => {
                if (targetId === socket.id) return;
                const target = players[targetId];
                if (target.hp <= 0) return;

                // Distância do ataque
                let range = 110; 
                if(p.hasGun) range = 400; // Arma atira de longe

                if (Math.hypot(p.x - target.x, p.y - target.y) < range) {
                    // Cálculo do Dano
                    let damage = 0.5; // Bicada normal
                    let pushForce = 40;

                    if (p.hasHammer) {
                        damage = 1.5;
                        pushForce = 120;
                    } else if (p.hasGun) {
                        damage = 2.0; // Dano da arma conforme pedido
                        pushForce = 20; // Tiro empurra pouco
                    }
                    
                    target.hp -= damage;

                    const angle = Math.atan2(target.y - p.y, target.x - p.x);
                    target.x += Math.cos(angle) * pushForce;
                    target.y += Math.sin(angle) * pushForce;
                    
                    target.x = Math.max(0, Math.min(MAP_W - 80, target.x));
                    target.y = Math.max(0, Math.min(MAP_H - 80, target.y));

                    io.emit('player_hit', { id: targetId, dmg: damage, byGun: p.hasGun });

                    if (target.hp <= 0) {
                        target.hp = 0;
                        io.emit('msg', `☠️ ${target.name} FOI PRO ESPETO!`);
                        
                        // Dropa itens se morrer
                        if (target.hasHammer) {
                            target.hasHammer = false; hammerHolderId = null;
                            hammer = { x: target.x, y: target.y };
                            io.emit('hammer_spawn', hammer);
                        }
                        if (target.hasGun) {
                            target.hasGun = false; gunHolderId = null;
                            gun = { x: target.x, y: target.y };
                            io.emit('gun_spawn', gun);
                        }

                        checkWinCondition();
                    }
                }
            });
        }
        io.emit('update_state', players);
    });

    socket.on('disconnect', () => {
        // Se desconectar segurando item, devolve pro jogo
        const p = players[socket.id];
        if(p) {
            if (p.hasHammer) { hammerHolderId = null; spawnHammer(); }
            if (p.hasGun) { gunHolderId = null; spawnGun(); }
        }
        delete players[socket.id];
        io.emit('update_state', players);
        io.emit('update_leaderboard', getLeaderboard());
        checkWinCondition();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`UFC GALO RODANDO NA PORTA: ${PORT}`));
