const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

// INICIALIZAÇÃO
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CONFIGURAÇÕES DE JOGO ---
const MAX_HAMMERS = 5;
const MAX_CORNS = 10;
const TIME_HAMMER = 40000; 
const TIME_CORN = 35000;   

// Valores de Dano e Cura (CONFORME SOLICITADO)
const DMG_PECK = 0.8;    // Bicada
const DMG_HAMMER = 1.2;  // Marreta
const DMG_FENCE = 0.5;   // Cerca (por tick)
const HEAL_CORN = 15.0;  // Milho

const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const PLAYER_SIZE = 60; 

let players = {};
let items = [];
let gameStarted = false;

// Contadores e Timers
let hammerCount = 0;
let cornCount = 0;
let hammerInterval = null;
let cornInterval = null;
let gameLoopInterval = null;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    console.log(`Galo conectado: ${socket.id}`);

    socket.on('join_game', (data) => {
        const cleanName = data.name ? data.name.trim().substring(0, 15) : "Galo Anônimo";
        
        players[socket.id] = {
            id: socket.id,
            name: cleanName,
            color: data.color || 'branco',
            x: Math.random() * (MAP_WIDTH - 100) + 50,
            y: Math.random() * (MAP_HEIGHT - 100) + 50,
            hp: 100,
            direction: 1, 
            wins: 0,
            hasHammer: false,
            dead: false,
            speed: 7,
            speedBoostTimer: null,
            lastAttackTime: 0
        };

        socket.emit('login_success', { id: socket.id, width: MAP_WIDTH, height: MAP_HEIGHT });
        io.emit('msg', `${cleanName} NO LOBBY!`);
        updateLeaderboard();

        // CORREÇÃO: Inicia o loop de movimentação imediatamente se tiver 1 pessoa
        if (!gameLoopInterval) {
            gameLoopInterval = setInterval(gameTick, 1000 / 60);
        }

        // Verifica se pode começar a "BATALHA" (Dano, itens, cerca)
        if (Object.keys(players).length >= 2 && !gameStarted) {
            startGameLogic();
        } else {
            // Envia itens atuais para quem entrou agora
            items.forEach(item => {
                if(item.type === 'hammer') socket.emit('hammer_spawn', item);
                if(item.type === 'corn') socket.emit('corn_spawn', item);
            });
        }
    });

    socket.on('move', (dir) => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        const currentSpeed = p.speed;

        if (dir === 'w') p.y -= currentSpeed;
        if (dir === 's') p.y += currentSpeed;
        if (dir === 'a') { p.x -= currentSpeed; p.direction = -1; }
        if (dir === 'd') { p.x += currentSpeed; p.direction = 1; }

        // Mantém dentro do mapa
        p.x = Math.max(0, Math.min(MAP_WIDTH - PLAYER_SIZE, p.x));
        p.y = Math.max(0, Math.min(MAP_HEIGHT - PLAYER_SIZE, p.y));
    });

    socket.on('dash', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        
        const dashDist = 100;
        p.x = Math.max(0, Math.min(MAP_WIDTH - PLAYER_SIZE, p.x + (dashDist * p.direction)));
        io.emit('action_anim', { id: p.id, type: 'dash' });
    });

    socket.on('click_action', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        const now = Date.now();
        if (now - p.lastAttackTime < 400) return; 
        p.lastAttackTime = now;

        io.emit('action_anim', { id: p.id, type: 'attack' });
        
        // Se a batalha não começou, não dá dano
        if (!gameStarted) return;

        const range = p.hasHammer ? 120 : 70;
        let damage = p.hasHammer ? DMG_HAMMER : DMG_PECK; 
        const isCrit = Math.random() < 0.20;
        if (isCrit) damage *= 2; 

        Object.values(players).forEach(target => {
            if (target.id !== p.id && !target.dead) {
                const dist = Math.hypot(target.x - p.x, target.y - p.y);
                if (dist < range) {
                    const angle = Math.atan2(target.y - p.y, target.x - p.x);
                    const force = p.hasHammer ? 20 : 10;
                    target.x += Math.cos(angle) * force;
                    target.y += Math.sin(angle) * force;
                    
                    takeDamage(target, damage, p.id, isCrit);
                }
            }
        });
    });

    socket.on('taunt', (index) => {
        const msgs = ["CÓCÓRÓCÓ!", "VEM X1!", "FRACO!", "GALO DOIDO!"];
        if (players[socket.id] && !players[socket.id].dead) {
            io.emit('msg_bubble', { id: socket.id, text: msgs[index] || "..." });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        
        // Se não sobrar ninguém, para o loop para economizar recurso
        if (Object.keys(players).length === 0) {
            stopGameLogic();
            if(gameLoopInterval) clearInterval(gameLoopInterval);
            gameLoopInterval = null;
        } else if (Object.keys(players).length < 2 && gameStarted) {
            // Se tinha gente jogando e sobrou só 1, para a batalha
            stopGameLogic();
            io.emit('msg', "ESPERANDO JOGADORES...");
        }

        io.emit('update_state', players);
        updateLeaderboard();
    });
});

// --- LÓGICA DO JOGO ---

function startGameLogic() {
    if (gameStarted) return;
    gameStarted = true;
    hammerCount = 0;
    cornCount = 0;

    console.log("BATALHA INICIADA");
    io.emit('msg', "VALENDO! A CERCA DÁ CHOQUE!");

    if(hammerInterval) clearInterval(hammerInterval);
    if(cornInterval) clearInterval(cornInterval);

    hammerInterval = setInterval(() => {
        if (hammerCount < MAX_HAMMERS) { spawnItem('hammer'); hammerCount++; }
    }, TIME_HAMMER);

    cornInterval = setInterval(() => {
        if (cornCount < MAX_CORNS) { spawnItem('corn'); cornCount++; }
    }, TIME_CORN);
}

function stopGameLogic() {
    gameStarted = false;
    clearInterval(hammerInterval);
    clearInterval(cornInterval);
    items = [];
    io.emit('clear_items');
    console.log("BATALHA PAUSADA");
}

function spawnItem(type) {
    const item = {
        id: Math.random().toString(36).substr(2, 9),
        type: type,
        x: Math.random() * (MAP_WIDTH - 60) + 30,
        y: Math.random() * (MAP_HEIGHT - 60) + 30
    };
    items.push(item);
    
    if (type === 'hammer') io.emit('hammer_spawn', item);
    if (type === 'corn') io.emit('corn_spawn', item);
}

function takeDamage(target, amount, attackerId, isCrit) {
    target.hp -= amount;
    target.hp = parseFloat(target.hp.toFixed(1)); 

    const isElectric = (attackerId === null);
    
    io.emit('player_hit', { id: target.id, crit: isCrit, electric: isElectric });

    if (target.hp <= 0 && !target.dead) {
        target.hp = 0;
        target.dead = true;
        target.hasHammer = false;
        
        io.emit('msg', `${target.name} VIROU CANJA!`);

        if (attackerId && players[attackerId]) {
            players[attackerId].wins++; 
            updateLeaderboard();
        }

        checkWinCondition();
    }
}

function checkWinCondition() {
    const alivePlayers = Object.values(players).filter(p => !p.dead);
    const totalPlayers = Object.keys(players).length;

    if (alivePlayers.length === 1 && totalPlayers > 1) {
        const winner = alivePlayers[0];
        winner.wins += 1;
        
        io.emit('show_winner', winner.name);
        updateLeaderboard();

        setTimeout(() => {
            resetRound();
            io.emit('hide_winner');
        }, 5000);
    } 
    else if (alivePlayers.length === 0 && totalPlayers > 1) {
        io.emit('msg', "EMPATE TOTAL!");
        setTimeout(resetRound, 3000);
    }
}

function resetRound() {
    // Se saiu todo mundo, não reseta
    if(Object.keys(players).length < 2) {
        stopGameLogic();
        return;
    }

    items = [];
    hammerCount = 0;
    cornCount = 0;
    io.emit('clear_items');
    
    Object.values(players).forEach(p => {
        p.hp = 100;
        p.dead = false;
        p.hasHammer = false;
        p.speed = 7;
        p.x = Math.random() * (MAP_WIDTH - 100) + 50;
        p.y = Math.random() * (MAP_HEIGHT - 100) + 50;
    });

    // Reinicia timers de itens
    clearInterval(hammerInterval);
    clearInterval(cornInterval);
    
    hammerInterval = setInterval(() => {
        if (hammerCount < MAX_HAMMERS) { spawnItem('hammer'); hammerCount++; }
    }, TIME_HAMMER);

    cornInterval = setInterval(() => {
        if (cornCount < MAX_CORNS) { spawnItem('corn'); cornCount++; }
    }, TIME_CORN);

    io.emit('update_state', players);
    io.emit('msg', "NOVA RODADA!");
}

function updateLeaderboard() {
    const sorted = Object.values(players).sort((a, b) => b.wins - a.wins).slice(0, 5);
    io.emit('update_leaderboard', sorted);
}

// O Loop principal roda sempre que tiver pelo menos 1 jogador
function gameTick() {
    // Se não tiver jogador, não faz nada
    if (Object.keys(players).length === 0) return;

    // LÓGICA DE DANO AMBIENTAL (Só se o jogo estiver "Valendo")
    if (gameStarted) {
        Object.values(players).forEach(p => {
            if(p.dead) return;

            // Dano Cerca Elétrica (0.5 por tick)
            let touchingFence = false;
            if (p.x <= 10 || p.x >= MAP_WIDTH - PLAYER_SIZE - 10 || 
                p.y <= 10 || p.y >= MAP_HEIGHT - PLAYER_SIZE - 10) {
                
                p.hp -= DMG_FENCE;
                p.hp = parseFloat(p.hp.toFixed(1));
                touchingFence = true;
                
                if (p.hp <= 0) takeDamage(p, 0, null, false);
            }
            
            if(touchingFence && Math.random() < 0.15) {
                 io.emit('player_hit', { id: p.id, electric: true, crit: false });
            }

            // Colisão Itens
            for (let i = items.length - 1; i >= 0; i--) {
                const item = items[i];
                const dist = Math.hypot(p.x - item.x, p.y - item.y);

                if (dist < 50) {
                    if (item.type === 'hammer') {
                        if (p.hasHammer) continue;
                        p.hasHammer = true;
                        io.emit('msg_bubble', { id: p.id, text: "MARRETA!" });
                    } else if (item.type === 'corn') {
                        // Recupera 15 de HP
                        p.hp = Math.min(100, p.hp + HEAL_CORN); 
                        
                        p.speed = 12; 
                        io.emit('msg_bubble', { id: p.id, text: "DELÍCIA!" });
                        
                        if (p.speedBoostTimer) clearTimeout(p.speedBoostTimer);
                        p.speedBoostTimer = setTimeout(() => { p.speed = 7; }, 3000);
                    }
                    
                    io.emit('item_update', { id: item.id, status: 'picked' });
                    items.splice(i, 1);
                }
            }
        });
    }

    // CORREÇÃO: Atualiza o estado SEMPRE (para ver o movimento no lobby)
    io.emit('update_state', players);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`SERVIDOR UFC GALO 7.1 RODANDO NA PORTA ${PORT}`);
});
