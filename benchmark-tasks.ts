TASK SPECIFICATIONS FOR KLIA TOKEN OPTIMIZER BENCHMARK
=====================================================

Generated from repository audit of: C:\ProyectosIA\Klia-Optimizer\klia-token-optimizer
Base task data from: pruebas/escenarios/tareas.json and historico-inyectado.json

Each task includes: id, taskType, query, description, expected optimizer candidates,
fixture data (baseline and optimized token expectations), and acceptance criteria.

--- TASK 1: SMALL_CODE ---
{
  "id": "T1_SMALL_CODE",
  "taskType": "SMALL_CODE",
  "query": "cambia el nombre de la variable foo por bar en src/index.ts",
  "description": "Modificar una función sencilla con un requisito claramente definido. Un solo archivo, un renombrado simple.",
  "expectedOptimizer": "BASELINE",
  "baseRulesCandidates": ["BASELINE"],
  "fixture": {
    "baseline": {
      "tokens": 1500,
      "latencySeconds": 5,
      "toolingCost": 0,
      "quality": 0.98,
      "failed": false,
      "contextSizeBytes": 5000
    },
    "optimized": {
      "tokens": 1500,  // Should be same as baseline for SMALL_CODE
      "latencySeconds": 5,
      "toolingCost": 0,
      "quality": 0.98,
      "failed": false,
      "contextSizeBytes": 5000
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensComparable": "diferencia <= 5% (deberia ser 0 para BASELINE)",
    "taskTypeCorrect": "SMALL_CODE"
  }
}

--- TASK 2: TERMINAL ---
{
  "id": "T2_TERMINAL",
  "taskType": "TERMINAL",
  "query": "ejecuta los tests con vitest y dime si fallan",
  "description": "Inspeccionar una salida de terminal o un log, identificar el problema y proponer una solución.",
  "expectedOptimizer": "RTK",
  "baseRulesCandidates": ["RTK", "DCP"],
  "fixture": {
    "baseline": {
      "tokens": 8500,
      "latencySeconds": 45,
      "toolingCost": 0,
      "quality": 0.95,
      "failed": false,
      "contextSizeBytes": 0,
      "hasTerminalCommands": true
    },
    "optimized": {
      "tokens": 1200,  // RTK should significantly reduce tokens from terminal
      "latencySeconds": 12,  // Less output to process
      "toolingCost": 0,
      "quality": 0.95,
      "failed": false,
      "contextSizeBytes": 0,
      "hasTerminalCommands": true,
      "tokensPruned": 7300  // RTK pruned tokens
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,  // Should save significant tokens
    "taskTypeCorrect": "TERMINAL"
  }
}

--- TASK 3: LARGE_CONTEXT ---
{
  "id": "T3_LARGE_CONTEXT",
  "taskType": "LARGE_CONTEXT",
  "query": "explica como funciona el sistema completo de scoring y seleccion de optimizadores",
  "description": "Analizar varios archivos o un conjunto de documentación de tamaño significativo.",
  "expectedOptimizer": "SEMBLE",
  "baseRulesCandidates": ["SEMBLE", "CONTEXT_MODE", "REPOMIX"],
  "fixture": {
    "baseline": {
      "tokens": 45000,
      "latencySeconds": 80,
      "toolingCost": 0,
      "quality": 0.92,
      "failed": false,
      "contextSizeBytes": 2000000,
      "fileCount": 8
    },
    "optimized": {
      "tokens": 6000,  // SEMBLE should return only chunk relevant
      "latencySeconds": 35,
      "toolingCost": 0,
      "quality": 0.92,
      "failed": false,
      "contextSizeBytes": 2000000,
      "fileCount": 8,
      "tokensPruned": 39000  // SEMBLE pruned tokens
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,  // Should save significant tokens
    "taskTypeCorrect": "LARGE_CONTEXT"
  }
}

--- TASK 4: REPOSITORY_SEARCH ---
{
  "id": "T4_REPOSITORY_SEARCH",
  "taskType": "REPOSITORY_SEARCH",
  "query": "busca todas las referencias a la funcion extractModelFamily en el repositorio",
  "description": "Encontrar una función, sus referencias y los archivos relevantes dentro de un proyecto real.",
  "expectedOptimizer": "CONTEXT_MODE",
  "baseRulesCandidates": ["CONTEXT_MODE", "REPOMIX"],
  "fixture": {
    "baseline": {
      "tokens": 32000,
      "latencySeconds": 60,
      "toolingCost": 0,
      "quality": 0.94,
      "failed": false,
      "contextSizeBytes": 0,
      "fileCount": 8
    },
    "optimized": {
      "tokens": 1800,  // CONTEXT_MODE should index and return chunk
      "latencySeconds": 8,
      "toolingCost": 0,
      "quality": 0.94,
      "failed": false,
      "contextSizeBytes": 0,
      "fileCount": 8,
      "tokensPruned": 30200  // CONTEXT_MODE pruned tokens
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "REPOSITORY_SEARCH"
  }
}

--- TASK 5: MULTISTEP ---
{
  "id": "T5_MULTISTEP",
  "taskType": "MULTISTEP",
  "query": "planifica la migracion del esquema v1 al v2 en varias fases",
  "description": "Investigar un problema, identificar la causa, implementar una solución y verificarla.",
  "expectedOptimizer": "DCP",
  "baseRulesCandidates": ["DCP"],
  "fixture": {
    "baseline": {
      "tokens": 28000,
      "latencySeconds": 120,
      "toolingCost": 0,
      "quality": 0.90,
      "failed": false,
      "contextSizeBytes": 200000,
      "fileCount": 4
    },
    "optimized": {
      "tokens": 9500,  // DCP should prune/compress context
      "latencySeconds": 88,
      "toolingCost": 0,
      "quality": 0.90,
      "failed": false,
      "contextSizeBytes": 200000,
      "fileCount": 4,
      "tokensPruned": 18500  // DCP pruned tokens
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "MULTISTEP"
  }
}

--- TASK 6: REFACTOR ---
{
  "id": "T6_REFACTOR",
  "taskType": "REFACTOR",
  "query": "refactoriza el modulo de historial para separar responsabilidades",
  "description": "Refactorizar una función o módulo manteniendo el comportamiento esperado.",
  "expectedOptimizer": "RTK",
  "baseRulesCandidates": ["RTK"],
  "fixture": {
    "baseline": {
      "tokens": 38000,
      "latencySeconds": 95,
      "toolingCost": 0,
      "quality": 0.93,
      "failed": false,
      "contextSizeBytes": 0,
      "fileCount": 4
    },
    "optimized": {
      "tokens": 4200,  // RTK should compress terminal/output during refactor
      "latencySeconds": 40,
      "toolingCost": 0,
      "quality": 0.93,
      "failed": false,
      "contextSizeBytes": 0,
      "fileCount": 4,
      "tokensPruned": 33800  // RTK pruned tokens
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "REFACTOR"
  }
}

--- TASK 7: ERROR_ANALYSIS ---
{
  "id": "T7_ERROR_ANALYSIS",
  "taskType": "TERMINAL",  // Shares signals with terminal (commands, logs)
  "query": "diagnostica el error ENOENT en la salida de npm install",
  "description": "Diagnosticar un error reproducible a partir de mensajes y código de ejemplo.",
  "expectedOptimizer": "RTK",
  "baseRulesCandidates": ["RTK", "DCP"],
  "fixture": {
    "baseline": {
      "tokens": 9200,
      "latencySeconds": 55,
      "toolingCost": 0,
      "quality": 0.91,
      "failed": false,
      "contextSizeBytes": 0,
      "hasTerminalCommands": true
    },
    "optimized": {
      "tokens": 1800,  // RTK should reduce noise in error logs
      "latencySeconds": 20,
      "toolingCost": 0,
      "quality": 0.91,
      "failed": false,
      "contextSizeBytes": 0,
      "hasTerminalCommands": true,
      "tokensPruned": 7400
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "TERMINAL"
  }
}

--- TASK 8: DOC_ANALYSIS ---
{
  "id": "T8_DOC_ANALYSIS",
  "taskType": "LARGE_CONTEXT",
  "query": "extrae los requisitos de seguridad y las limitaciones de la politica de contexto para despliegue en produccion",
  "description": "Extraer requisitos de varios documentos y responder preguntas verificables.",
  "expectedOptimizer": "CONTEXT_MODE",
  "baseRulesCandidates": ["CONTEXT_MODE", "REPOMIX"],
  "fixture": {
    "baseline": {
      "tokens": 25000,
      "latencySeconds": 70,
      "toolingCost": 0,
      "quality": 0.88,
      "failed": false,
      "contextSizeBytes": 500000,
      "fileCount": 5
    },
    "optimized": {
      "tokens": 5200,  // CONTEXT_MODE should index and return relevant fragments
      "latencySeconds": 25,
      "toolingCost": 0,
      "quality": 0.88,
      "failed": false,
      "contextSizeBytes": 500000,
      "fileCount": 5,
      "tokensPruned": 19800
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "LARGE_CONTEXT"
  }
}

--- TASK 9: TESTS ---
{
  "id": "T9_TESTS",
  "taskType": "TERMINAL",
  "query": "agrega una prueba automatizada que verifique que el modulo de auth retorna el token correcto",
  "description": "Añadir o reparar pruebas automatizadas y comprobar que pasan.",
  "expectedOptimizer": "RTK",
  "baseRulesCandidates": ["RTK", "DCP"],
  "fixture": {
    "baseline": {
      "tokens": 7800,
      "latencySeconds": 65,
      "toolingCost": 0.3,
      "quality": 0.94,
      "failed": false,
      "contextSizeBytes": 0,
      "hasTerminalCommands": true
    },
    "optimized": {
      "tokens": 2100,  // RTK should reduce noise from test output
      "latencySeconds": 28,
      "toolingCost": 0.3,
      "quality": 0.94,
      "failed": false,
      "contextSizeBytes": 0,
      "hasTerminalCommands": true,
      "tokensPruned": 5700,
      "actualToolCalls": 2  // vitest tool calls
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "TERMINAL"
  }
}

--- TASK 10: CONTROL ---
{
  "id": "T10_CONTROL",
  "taskType": "SMALL_CODE",
  "query": "muestra el contenido de la funcion principal de index.ts",
  "description": "Ejecutar una tarea breve que permita detectar si el propio overhead de Klia aumenta el consumo en trabajos pequeños.",
  "expectedOptimizer": "BASELINE",
  "baseRulesCandidates": ["BASELINE"],
  "fixture": {
    "baseline": {
      "tokens": 800,
      "latencySeconds": 3,
      "toolingCost": 0,
      "quality": 0.99,
      "failed": false,
      "contextSizeBytes": 2000
    },
    "optimized": {
      "tokens": 850,  // Small overhead from Klia router, but BASELINE should be nearly identical
      "latencySeconds": 3,
      "toolingCost": 0,
      "quality": 0.99,
      "failed": false,
      "contextSizeBytes": 2000,
      "overheadTokens": 50  // Klia overhead measured
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "overheadAcceptable": true,  // Klia overhead should not exceed savings
    "taskTypeCorrect": "SMALL_CODE"
  }
}

--- TASK 11: COMPLEX_QUERY ---
{
  "id": "T11_COMPLEX_QUERY",
  "taskType": "LARGE_CONTEXT",
  "query": "analiza la arquitectura del sistema de historiales y su evolution a traves de 3 versiones, identificando patrones de cambio en los archivos de configuracion y sus implicaciones de seguridad",
  "description": "Analizar un problema complejo que requiere comprender multiples facets del sistema.",
  "expectedOptimizer": "SEMBLE",
  "baseRulesCandidates": ["SEMBLE", "CONTEXT_MODE", "REPOMIX"],
  "fixture": {
    "baseline": {
      "tokens": 52000,
      "latencySeconds": 110,
      "toolingCost": 0,
      "quality": 0.85,
      "failed": false,
      "contextSizeBytes": 5000000,
      "fileCount": 15
    },
    "optimized": {
      "tokens": 8500,  // SEMBLE should semantic search and return only relevant chunks
      "latencySeconds": 45,
      "toolingCost": 0,
      "quality": 0.85,
      "failed": false,
      "contextSizeBytes": 5000000,
      "fileCount": 15,
      "tokensPruned": 43500
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "tokensAbsoluteSavings": true,
    "taskTypeCorrect": "LARGE_CONTEXT"
  }
}

--- TASK 12: REPO_STRUCTURE ---
{
  "id": "T12_REPO_STRUCTURE",
  "taskType": "REPOSITORY_SEARCH",
  "query": "muestra la estructura del repositorio y las dependencias principales",
  "description": "Entender la arquitectura completa de un proyecto desconocido.",
  "expectedOptimizer": "REPOMIX",
  "baseRulesCandidates": ["CONTEXT_MODE", "REPOMIX"],
  "fixture": {
    "baseline": {
      "tokens": 22000,
      "latencySeconds": 95,
      "toolingCost": 0,
      "quality": 0.92,
      "failed": false,
      "contextSizeBytes": 0,
      "fileCount": 0
    },
    "optimized": {
      "tokens": 8000,  // REPOMIX should package repo signatures (less than full read)
      "latencySeconds": 60,
      "toolingCost": 0.5,  // Repomix has tooling cost for packaging
      "quality": 0.92,
      "failed": false,
      "contextSizeBytes": 0,
      "fileCount": 0,
      "tokensPruned": 14000
    }
  },
  "acceptanceCriteria": {
    "qualityEquivalent": true,
    "measuresRepositoryStructure": true,
    "taskTypeCorrect": "REPOSITORY_SEARCH"
  }
}