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
let items = []; // Itens no chão
let bullets = []; // Projéteis da arma
let gameStarted = false;

const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const PLAYER_SIZE = 60;

// Configuração dos tempos (EM SEGUNDOS)
const TIME_MARTELO = 35;
const TIME_MILHO = 40;
const TIME_ARMA = 90; // 1 minuto e meio

io.on('connection', (socket) => {
    console.log(`Nova alma na rinha: ${socket.id}`);

    // Cria o jogador
    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name.substring(0, 10),
            color: data.color,
            x: Math.random() * (MAP_WIDTH - 100) + 50,
            y: Math.random() * (MAP_HEIGHT - 100) + 50,
            hp: 100,
            direction: 1, // 1 direita, -1 esquerda
            wins: 0,
            hasHammer: false,
            hasGun: false,
            dead: false
        };

        socket.emit('login_success', { id: socket.id, width: MAP_WIDTH, height: MAP_HEIGHT });
        io.emit('msg', `${players[socket.id].name} ENTROU NA RINHA!`);
        updateLeaderboard();

        // Se for o primeiro jogador, inicia os cronômetros dos itens
        if (Object.keys(players).length === 1 && !gameStarted) {
            gameStarted = true;
            iniciarTimersDeItens();
        }
    });

    // Movimentação
    socket.on('move', (dir) => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        const speed = 7;
        if (dir === 'w') p.y = Math.max(0, p.y - speed);
        if (dir === 's') p.y = Math.min(MAP_HEIGHT - PLAYER_SIZE, p.y + speed);
        if (dir === 'a') { p.x = Math.max(0, p.x - speed); p.direction = -1; }
        if (dir === 'd') { p.x = Math.min(MAP_WIDTH - PLAYER_SIZE, p.x + speed); p.direction = 1; }
    });

    // Dash (Espaço)
    socket.on('dash', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        
        // Pulo simples para frente
        const dashDist = 80;
        p.x = Math.max(0, Math.min(MAP_WIDTH - PLAYER_SIZE, p.x + (dashDist * p.direction)));
        io.emit('action_anim', { id: p.id, type: 'dash' });
    });

    // AÇÃO DE CLIQUE (Atacar ou Atirar)
    socket.on('click_action', () => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        // 1. Lógica da ARMA (Tiro)
        if (p.hasGun) {
            io.emit('action_anim', { id: p.id, type: 'shoot' });
            // Cria a bala
            bullets.push({
                x: p.x + (p.direction === 1 ? 50 : 0),
                y: p.y + 30,
                vx: p.direction * 15, // Velocidade da bala
                owner: p.id
            });
            return;
        }

        // 2. Lógica do MARTELO e BICADA (Melee)
        io.emit('action_anim', { id: p.id, type: 'attack' });
        
        const range = p.hasHammer ? 90 : 50;
        const damage = p.hasHammer ? 30 : 5;

        // Checa quem foi acertado
        Object.values(players).forEach(target => {
            if (target.id !== p.id && !target.dead) {
                const dist = Math.hypot(target.x - p.x, target.y - p.y);
                if (dist < range) {
                    takeDamage(target, damage, p.id);
                }
            }
        });
    });

    // Chat / Provocação
    socket.on('taunt', (index) => {
        const msgs = ["PÓ PÓ PÓ!", "VEM TRANQUILO!", "GALO DOIDO!"];
        if (players[socket.id]) {
            io.emit('msg_bubble', { id: socket.id, text: msgs[index] || "CÓRÓCÓ!" });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        if (Object.keys(players).length === 0) {
            gameStarted = false; // Reinicia lógica se todos saírem
            items = [];
            bullets = [];
        }
        io.emit('update_state', players);
    });
});

// --- FUNÇÕES DE LÓGICA DO JOGO ---

function iniciarTimersDeItens() {
    console.log("Cronômetros iniciados!");

    // Martelo: 35 segundos
    setTimeout(() => spawnItem('hammer'), TIME_MARTELO * 1000);

    // Milho: 40 segundos
    setTimeout(() => spawnItem('corn'), TIME_MILHO * 1000);

    // Arma: 1 minuto e meio (90 segundos)
    setTimeout(() => spawnItem('gun'), TIME_ARMA * 1000);
}

function spawnItem(type) {
    const item = {
        id: Math.random().toString(36).substr(2, 9),
        type: type, // 'hammer', 'gun', 'corn'
        x: Math.random() * (MAP_WIDTH - 50),
        y: Math.random() * (MAP_HEIGHT - 50)
    };
    items.push(item);
    
    // Emite o evento específico para o frontend desenhar o emoji certo
    if(type === 'hammer') io.emit('hammer_spawn', item);
    if(type === 'gun') io.emit('gun_spawn', item);
    if(type === 'corn') io.emit('corn_spawn', item);
}

function takeDamage(target, amount, attackerId) {
    target.hp -= amount;
    io.emit('player_hit', { id: target.id, byGun: false });

    if (target.hp <= 0) {
        target.hp = 0;
        target.dead = true;
        target.hasGun = false;
        target.hasHammer = false;
        io.emit('msg', `${target.name} VIROU CANJA!`);
        
        if (attackerId && players[attackerId]) {
            players[attackerId].wins++;
            updateLeaderboard();
            io.emit('show_winner', players[attackerId].name);
            setTimeout(() => {
                resetGame(); 
                io.emit('hide_winner');
            }, 5000);
        }
    }
}

function resetGame() {
    items = [];
    bullets = [];
    io.emit('clear_items');
    Object.values(players).forEach(p => {
        p.hp = 100;
        p.dead = false;
        p.hasGun = false;
        p.hasHammer = false;
        p.x = Math.random() * (MAP_WIDTH - 100);
        p.y = Math.random() * (MAP_HEIGHT - 100);
    });
    // Reinicia os timers para a próxima rodada
    iniciarTimersDeItens(); 
}

function updateLeaderboard() {
    const sorted = Object.values(players).sort((a, b) => b.wins - a.wins).slice(0, 5);
    io.emit('update_leaderboard', sorted);
}

// GAME LOOP (Roda 60 vezes por segundo)
setInterval(() => {
    // 1. Atualizar Balas
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;

        // Remover se sair do mapa
        if (b.x < 0 || b.x > MAP_WIDTH) {
            bullets.splice(i, 1);
            continue;
        }

        // Colisão Bala vs Player
        let hit = false;
        Object.values(players).forEach(p => {
            if (p.id !== b.owner && !p.dead) {
                // Hitbox simples
                if (b.x > p.x && b.x < p.x + PLAYER_SIZE && b.y > p.y && b.y < p.y + PLAYER_SIZE) {
                    takeDamage(p, 20, b.owner); // Dano do tiro = 20
                    io.emit('player_hit', { id: p.id, byGun: true });
                    hit = true;
                }
            }
        });

        if (hit) {
            bullets.splice(i, 1);
        }
    }

    // 2. Colisão Player vs Itens
    Object.values(players).forEach(p => {
        if(p.dead) return;
        
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const dx = p.x - item.x;
            const dy = p.y - item.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist < 50) {
                // Pegou o item
                if (item.type === 'corn') {
                    p.hp = Math.min(100, p.hp + 30);
                    io.emit('msg_bubble', { id: p.id, text: "DELÍCIA!" });
                } else if (item.type === 'hammer') {
                    p.hasHammer = true;
                    p.hasGun = false; // Solta a arma se pegar martelo
                    io.emit('msg_bubble', { id: p.id, text: "HORA DA MARRETADA!" });
                } else if (item.type === 'gun') {
                    p.hasGun = true;
                    p.hasHammer = false; // Solta o martelo se pegar arma
                    io.emit('msg_bubble', { id: p.id, text: "O PAI TÁ ARMADO!" });
                }

                // Avisa front pra remover o item visualmente
                io.emit('item_update', { id: item.id, type: item.type, status: 'picked' });
                items.splice(i, 1);
            }
        }
    });

    // Envia estado atualizado para todos (Players + Balas)
    io.emit('update_state', players);
    io.emit('update_bullets', bullets);

}, 1000 / 60);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`UFC GALO 3.0 RODANDO NA PORTA: ${PORT}`);
});
