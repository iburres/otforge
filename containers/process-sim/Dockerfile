FROM python:3.12-alpine

# Physical process simulation for ICS Simulator (Phase 11).
# Runs a Modbus TCP server backed by real physics: water tank level control,
# pipeline pressure dynamics, generator swing-equation frequency response,
# or a configurable multi-frequency signal generator.
# PROCESS_TYPE env var selects the model; all other vars set process parameters.

WORKDIR /app

# pymodbus 3.7 is pure Python — no C compilation needed on Alpine.
# Pin to the same version used by the other device containers for consistency.
RUN pip install --no-cache-dir "pymodbus==3.7.4"

COPY sim.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# ── Default environment variables (all overridable by Docker Compose) ─────────
# SIM_SEED is deliberately absent: leaving it unset makes the simulator draw a
# random noise seed and log it, so lab runs stay varied but remain replayable.
# Set it explicitly to reproduce a specific run.
ENV DEVICE_ID=process-1 \
    PROCESS_TYPE=water-tank \
    MODBUS_PORT=502 \
    MODBUS_UNIT_ID=1 \
    SIM_DT_MS=1000 \
    SIM_REALTIME=1 \
    TANK_VOLUME_L=1000.0 \
    TANK_AREA_M2=1.0 \
    PUMP_FLOW_MAX_LPM=150.0 \
    VALVE_FLOW_MAX_LPM=200.0 \
    INITIAL_LEVEL_PCT=50.0 \
    GENERATOR_RATED_MW=100.0 \
    GENERATOR_INERTIA_H=6.0 \
    GENERATOR_FREQ_BASE=50.0 \
    PIPELINE_VOLUME_L=500.0 \
    PIPELINE_PUMP_MAX_LPM=300.0

EXPOSE 502

ENTRYPOINT ["./entrypoint.sh"]
