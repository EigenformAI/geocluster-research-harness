ARG CANDIDATE=gc-processor-candidate:required
FROM ${CANDIDATE}
# Test dependencies live beside the production venv, never inside it.
RUN uv pip install --python /opt/geocluster-preprocessing/bin/python --no-cache --no-deps \
       --target /qualification/deps pytest==8.4.2 pytest-asyncio==1.2.0 \
       iniconfig==2.1.0 packaging==25.0 pluggy==1.6.0 pygments==2.19.2
COPY test_engine_http_real.py processor-protocol-runner.py /qualification/
ENV PYTHONPATH=/qualification/deps
ENV PREPROCESSING_TEST_OPENCODE=/opt/opencode/engine/bin/opencode
ENV PREPROCESSING_TEST_INSTALLED_ROOT=/opt/geocluster-preprocessing
WORKDIR /qualification
